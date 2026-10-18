import type { PluginManifest } from "../../contract";

export const hostileManifest = (processors: string[] = ["probe"]): PluginManifest => ({
  id: "test.hostile",
  version: "1.0.0",
  recognizes: [{ mediaTypes: ["text/plain"] }],
  processors,
  views: processors[0],
  services: [],
});
