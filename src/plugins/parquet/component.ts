// Browser component for the Parquet plugin: reads the file through the host by byte range
// and runs a filtered scan in the frame. It stands in for DuckDB-WASM, which the frame's
// CSP blocks (no 'wasm-unsafe-eval'), and keeps to pure JavaScript.
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer } from "hyparquet";
import type { ComponentHost } from "../../contract";

declare const magpie: ComponentHost;
const CALL_LIMIT = 1024 * 1024; // the host refuses larger component reads

let { byteLength } = (await magpie.getData()) as { byteLength: number };
let file: AsyncBuffer = {
  byteLength,
  async slice(start, end = byteLength) {
    let out = new Uint8Array(end - start);
    for (let offset = start; offset < end; offset += CALL_LIMIT) {
      out.set(await magpie.read("original", { offset, length: Math.min(CALL_LIMIT, end - offset) }), offset - start);
    }
    return out.buffer;
  },
};
let metadata = await parquetMetadataAsync(file, { initialFetchSize: 16 * 1024 });
let rows = await parquetReadObjects({ file, metadata, columns: ["sensor", "strain_microstrain"], rowStart: 0, rowEnd: 30000 });
let peak = rows.filter((row) => row.sensor === "north-anchorage").reduce((max, row) => Math.max(max, row.strain_microstrain), -Infinity);
let output = document.createElement("p");
output.id = "answer";
output.textContent = `Peak north-anchorage strain in row group 1: ${peak} µε`;
document.body.append(output);
