import type { PluginId, PluginManifest } from "../contract";

export interface InputDescription {
  mediaType: string;
  filename?: string;
  url?: string;
}

// More specific evidence wins: a source host beats a file extension, which beats a media type.
function score(manifest: PluginManifest, input: InputDescription): number {
  let host = input.url ? URL.parse(input.url)?.hostname : undefined;
  let extension = input.filename?.match(/\.[^.]+$/)?.[0].toLowerCase();
  let mediaType = input.mediaType.split(";")[0].trim().toLowerCase();
  let best = 0;
  for (let recognizer of manifest.recognizes) {
    if (host && recognizer.hosts?.includes(host)) best = Math.max(best, 4);
    if (extension && recognizer.extensions?.includes(extension)) best = Math.max(best, 3);
    for (let pattern of recognizer.mediaTypes ?? []) {
      if (pattern === mediaType) best = Math.max(best, 2);
      else if (pattern.endsWith("/*") && mediaType.startsWith(pattern.slice(0, -1))) best = Math.max(best, 1);
    }
  }
  return best;
}

/** Picks one primary plugin. Ties resolve by plugin ID so the choice is repeatable. */
export function selectPlugin(
  manifests: readonly PluginManifest[],
  input: InputDescription,
): { plugin: PluginId | null; alternatives: PluginId[] } {
  let ranked = manifests
    .map((manifest) => ({ id: manifest.id, score: score(manifest, input) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { plugin: ranked[0]?.id ?? null, alternatives: ranked.slice(1).map((candidate) => candidate.id) };
}
