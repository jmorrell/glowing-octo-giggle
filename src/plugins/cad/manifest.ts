import type { PluginManifest } from "../../contract";

export const cadManifest = (version: string): PluginManifest => ({
  id: "example.cad",
  version,
  recognizes: [{ extensions: [".step", ".stp"], mediaTypes: ["model/step"] }],
  processors: ["model"],
  views: "model",
  services: [],
});
