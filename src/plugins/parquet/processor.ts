import { WorkerEntrypoint } from "cloudflare:workers";
import { parquetMetadataAsync, parquetReadObjects, parquetSchema, type AsyncBuffer } from "hyparquet";
import type { HostCapabilities, ProcessRequest, ProcessResult, ProcessorEntrypoint, SearchSegment } from "../../contract";

const MAX_CALL = 8 * 1024 * 1024; // HostCapabilities.readOriginal limit per call
const DISTINCT_LIMIT = 50;
const SMALL_COLUMN_BYTES = 64 * 1024;

// hyparquet reads through this, so it fetches the footer and only the column chunks it needs.
function originalAsBuffer(host: HostCapabilities, byteLength: number): AsyncBuffer {
  return {
    byteLength,
    async slice(start, end = byteLength) {
      let out = new Uint8Array(end - start);
      for (let offset = start; offset < end; offset += MAX_CALL) {
        out.set(await host.readOriginal({ offset, length: Math.min(MAX_CALL, end - offset) }), offset - start);
      }
      return out.buffer;
    },
  };
}

const show = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === "bigint" ? value.toString() : String(value));

export default class ParquetProcessor extends WorkerEntrypoint implements ProcessorEntrypoint {
  async process(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult> {
    let file = originalAsBuffer(host, request.original.byteLength);
    // hyparquet prefetches 512 KiB for the footer by default; the footer here is ~2 KiB.
    let metadata = await parquetMetadataAsync(file, { initialFetchSize: 16 * 1024 });
    let columns = parquetSchema(metadata).children.map((child) => child.element);
    let rows = Number(metadata.num_rows);
    let name = request.item.input.kind === "upload" ? request.item.input.filename : "Parquet file";

    // Searchable content is chosen here: schema and value ranges from the footer, plus the
    // distinct values of small string columns. Row values are never indexed.
    let search: SearchSegment[] = [{ text: `${name}: ${columns.map((c) => c.name).join(", ")}` }];
    let columnLines: string[] = [];
    for (let [index, column] of columns.entries()) {
      let chunks = metadata.row_groups.map((group) => group.columns[index].meta_data!);
      let stats = chunks.map((chunk) => chunk.statistics).filter((s) => s !== undefined);
      let min = stats.map((s) => s.min_value ?? s.min).reduce((a, b) => (b !== undefined && (a === undefined || b < a) ? b : a), undefined);
      let max = stats.map((s) => s.max_value ?? s.max).reduce((a, b) => (b !== undefined && (a === undefined || b > a) ? b : a), undefined);
      let type = column.logical_type?.type ?? column.converted_type ?? column.type;
      let line = `${column.name} (${type})${min !== undefined ? `: ${show(min)} to ${show(max)}` : ""}`;
      let compressed = chunks.reduce((sum, chunk) => sum + Number(chunk.total_compressed_size), 0);
      if (column.type === "BYTE_ARRAY" && compressed <= SMALL_COLUMN_BYTES) {
        let values = new Set((await parquetReadObjects({ file, metadata, columns: [column.name] })).map((row) => String(row[column.name])));
        if (values.size <= DISTINCT_LIMIT) line += ` · values: ${[...values].sort().join(", ")}`;
      }
      columnLines.push(line);
      search.push({ text: `Column ${line}` });
    }
    let preview = await parquetReadObjects({ file, metadata, rowStart: 0, rowEnd: 5, useOffsetIndex: true });
    // The component needs the original's length to read it by range; ComponentHost does not
    // expose it, so it travels in this plugin's own data artifact.
    await host.putArtifact("table.json", JSON.stringify({ byteLength: request.original.byteLength }), "application/json");
    return {
      metadata: { title: name },
      search,
      views: {
        card: { title: name, subtitle: `${rows.toLocaleString("en-US")} rows · ${columns.length} columns`, badges: ["parquet"] },
        detail: {
          template: "custom",
          component: "table",
          data: { processor: "schema", name: "table.json" },
          fallback: {
            template: "record",
            fields: [
              { label: "Rows", value: String(rows) },
              { label: "Row groups", value: String(metadata.row_groups.length) },
              { label: "Written by", value: metadata.created_by ?? "unknown" },
            ],
            lists: [
              { label: "Columns", items: columnLines },
              { label: "First rows", items: preview.map((row) => Object.values(row).map(show).join(" · ")) },
            ],
          },
        },
      },
    };
  }
}
