import type { PluginManifest } from "../../contract";

export const videoManifest = (version: string): PluginManifest => ({
  id: "example.video",
  version,
  recognizes: [{ mediaTypes: ["video/webm"], extensions: [".webm"] }],
  processors: ["media", "transcript", "frames"],
  views: "media",
  services: ["transcribe", "extract-frames", "describe-image"],
});
