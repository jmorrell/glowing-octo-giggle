import type { AnchorState, ArtifactAddress, RevisionId, Selector, TextQuoteSelector, TranscriptCue } from "../contract";

/** Text of a host-standard artifact as it exists in the item's current outputs. */
export type TextLayer = { text: string; cues?: TranscriptCue[] };

export interface CurrentItem {
  revision: RevisionId;
  /** Keyed by `${processor}/${name}`; missing when that output has not committed. */
  layers: ReadonlyMap<string, TextLayer>;
}

export interface Placement {
  state: AnchorState;
  /** Time range the media template should mark, when one is known. */
  time?: { start: number; end: number };
}

export const layerKey = (address: ArtifactAddress) => `${address.processor}/${address.name}`;
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

export function cueText(cues: readonly TranscriptCue[]): string {
  return cues.map((cue) => normalize(cue.text)).join(" ");
}

// A quote is placed only when it occurs exactly once with matching context. Ambiguity and
// changed context both orphan the annotation instead of guessing a new location.
function findQuote(layer: TextLayer, quote: TextQuoteSelector): number | null {
  let text = normalize(layer.text);
  let exact = normalize(quote.exact);
  let prefix = normalize(quote.prefix ?? "");
  let suffix = normalize(quote.suffix ?? "");
  let matches: number[] = [];
  for (let index = text.indexOf(exact); index !== -1; index = text.indexOf(exact, index + 1)) {
    let before = text.slice(0, index).trimEnd();
    let after = text.slice(index + exact.length).trimStart();
    if (before.endsWith(prefix) && after.startsWith(suffix)) matches.push(index);
  }
  return matches.length === 1 ? matches[0] : null;
}

function cueAt(cues: readonly TranscriptCue[], offset: number): TranscriptCue | undefined {
  let position = 0;
  for (let cue of cues) {
    position += normalize(cue.text).length + 1;
    if (offset < position) return cue;
  }
  return undefined;
}

export function placeAnnotation(selectors: readonly Selector[], annotatedRevision: RevisionId, current: CurrentItem): Placement {
  let sameRevision = annotatedRevision === current.revision;
  if (selectors.some((selector) => selector.type === "plugin")) {
    // Plugin selectors address the original; a new revision may renumber what they name.
    return { state: sameRevision ? "delegated" : "orphaned" };
  }
  let time = selectors.find((selector) => selector.type === "time");
  let quote = selectors.find((selector) => selector.type === "text-quote");
  let layer = quote ? current.layers.get(layerKey(quote.in)) : undefined;

  if (time && sameRevision) {
    let range = { start: time.start, end: time.end };
    if (!quote) return { state: "exact", time: range };
    let overlapping = (layer?.cues ?? []).filter((cue) => cue.end > time.start && cue.start < time.end);
    let windowText = cueText(overlapping);
    return { state: windowText.includes(normalize(quote.exact)) ? "exact" : "text-changed", time: range };
  }
  if (!quote || !layer) return { state: "orphaned" };
  let offset = findQuote(layer, quote);
  if (offset === null) return { state: "orphaned" };
  let cue = layer.cues ? cueAt(layer.cues, offset) : undefined;
  return { state: "exact", time: cue ? { start: cue.start, end: cue.end } : undefined };
}
