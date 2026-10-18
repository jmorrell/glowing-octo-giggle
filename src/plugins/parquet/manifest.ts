import type { PluginManifest } from "../../contract";

export const parquetManifest = (): PluginManifest => ({
  id: "example.parquet",
  version: "1.0.0",
  recognizes: [{ extensions: [".parquet"], mediaTypes: ["application/vnd.apache.parquet"] }],
  processors: ["schema"],
  views: "schema",
  services: [],
});
