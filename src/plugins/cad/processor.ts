import { WorkerEntrypoint } from "cloudflare:workers";
import type { HostCapabilities, ProcessRequest, ProcessResult, ProcessorEntrypoint, SearchSegment } from "../../contract";

declare const INCLUDE_ASSEMBLY: boolean; // v2 also reports assembly relationships

export type Part = { entity: string; id: string; name: string; description: string };

// Enough ISO 10303-21 for this experiment: one entity per line, quoted string arguments.
// STEP files from real CAD tools need a proper parser (and are often far larger).
function parse(text: string) {
  let header = (keyword: string) => text.match(new RegExp(`${keyword}\\(\\('?([^']*)'?`))?.[1] ?? "unknown";
  let entities = [...text.matchAll(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\);\s*$/gm)].map((m) => ({ entity: `#${m[1]}`, type: m[2], args: m[3] }));
  let strings = (args: string) => [...args.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  let parts: Part[] = entities
    .filter((e) => e.type === "PRODUCT")
    .map((e) => {
      let [id, name, description] = strings(e.args);
      return { entity: e.entity, id, name, description };
    });
  let usages = entities
    .filter((e) => e.type === "NEXT_ASSEMBLY_USAGE_OCCURRENCE")
    .map((e) => {
      let [, parent, child] = [...e.args.matchAll(/#(\d+)/g)].map((m) => `#${m[1]}`).slice(-3);
      return { parent, child };
    });
  return { schema: header("FILE_SCHEMA").split(" ")[0], description: header("FILE_DESCRIPTION"), entityCount: entities.length, parts, usages };
}

export default class CadProcessor extends WorkerEntrypoint implements ProcessorEntrypoint {
  async process(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult> {
    if (request.original.byteLength > 8 * 1024 * 1024) throw new Error("STEP files over 8 MiB are not supported by this experiment");
    let model = parse(new TextDecoder().decode(await host.readOriginal()));
    let label = (part: Part) => `${part.name} (${part.entity})`;
    let name = request.item.input.kind === "upload" ? request.item.input.filename : "CAD model";
    await host.putArtifact("parts.json", JSON.stringify({ parts: model.parts, usages: INCLUDE_ASSEMBLY ? model.usages : [] }), "application/json");
    let search: SearchSegment[] = [
      { text: model.description },
      ...model.parts.map((part) => ({
        text: `${part.name}: ${part.description}`,
        target: { type: "plugin" as const, plugin: "example.cad", value: part.entity, label: label(part) },
      })),
    ];
    let byId = new Map(model.parts.map((part) => [part.entity, part]));
    let lists = [{ label: "Parts", items: model.parts.map((part) => `${label(part)}: ${part.description}`) }];
    if (INCLUDE_ASSEMBLY) {
      lists.push({ label: "Assembly", items: model.usages.map((u) => `${byId.get(u.child)?.name ?? u.child} in ${byId.get(u.parent)?.name ?? u.parent}`) });
    }
    return {
      metadata: { title: name, description: model.description },
      search,
      views: {
        card: { title: name, subtitle: `${model.parts.length} parts · ${model.schema}`, badges: ["cad"] },
        detail: {
          template: "custom",
          component: "viewer",
          data: { processor: "model", name: "parts.json" },
          fallback: {
            template: "record",
            fields: [
              { label: "Schema", value: model.schema },
              { label: "Entities", value: String(model.entityCount) },
            ],
            lists,
          },
        },
      },
    };
  }
}
