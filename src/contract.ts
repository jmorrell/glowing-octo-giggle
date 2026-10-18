// The Magpie extension contract, as tested in this repository.
//
//   Release            data a plugin ships; validated by the host at install
//   Plugin hooks       code the host invokes: a processor in a Dynamic Worker with no network
//                      and no bindings, and optional components in an opaque-origin iframe
//   Host capabilities  what the host lends one invocation; checked by the host on every call
//   Persisted data     what the host stores, renders, and owns
//
// Types describe the protocol. They enforce nothing: every rule here is checked at runtime by
// src/host (see validate.ts, library.ts, plugin-host.ts, and the component host in ui.ts).

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

export type ItemId = string;
/** One immutable original of an item. A refetch or an authored edit creates a new revision. */
export type RevisionId = string;
export type PluginId = string;
export type ProcessorName = string;
export type ComponentName = string;
/** Name of an artifact within one processor's output, e.g. "cues.json". [a-z0-9][a-z0-9._-]{0,99} */
export type ArtifactName = string;

/**
 * Stable address of a derived artifact within an item. It survives reprocessing: the host
 * resolves it to whichever run is the processor's current committed output.
 */
export type ArtifactAddress = { processor: ProcessorName; name: ArtifactName };
export type ContentRef = "original" | ArtifactAddress;

// ---------------------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------------------

export interface PluginRelease {
  manifest: PluginManifest;
  /** ES modules for the processor isolate; `processor.js` is the main module. */
  processorModules: Record<string, string>;
  /** One browser module per component, evaluated inside the component frame. */
  componentModules?: Record<ComponentName, ComponentModule>;
}

export interface PluginManifest {
  id: PluginId;
  version: string;
  /** Declarative; the host picks one plugin per item without running plugin code. */
  recognizes: Recognizer[];
  /** Each processor produces one output that commits independently. Runs in this order. */
  processors: ProcessorName[];
  /** The processor whose output supplies the item's card and detail views. */
  views: ProcessorName;
  /** Host services the processors may call. Anything not listed is refused. */
  services: ServiceName[];
}

/** Most specific evidence wins: hosts, then extensions, then exact, then wildcard types. */
export interface Recognizer {
  mediaTypes?: string[]; // "video/webm" or "video/*"
  extensions?: string[]; // ".step"
  hosts?: string[]; // source URL hostnames, e.g. "www.youtube.com"
}

export type ServiceName = "transcribe" | "extract-frames" | "describe-image";

// ---------------------------------------------------------------------------------------
// Plugin hooks
// ---------------------------------------------------------------------------------------

/** The default export of `processor.js`: a WorkerEntrypoint implementing this. */
export interface ProcessorEntrypoint {
  /**
   * Called once per attempt of one run. `host` carries that run's authority and works only
   * during this call. Results are validated, then committed atomically for this processor.
   */
  process(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult>;
}

export interface ProcessRequest {
  processor: ProcessorName;
  item: { id: ItemId; input: InputFacts };
  original: OriginalFacts;
}

export type InputFacts =
  | { kind: "url"; url: string }
  | { kind: "capture"; url: string }
  | { kind: "upload"; filename: string }
  | { kind: "authored" };

export interface OriginalFacts {
  revision: RevisionId;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface ProcessResult {
  /** Exactly what becomes searchable for this output; replaced atomically on reprocessing. */
  search?: SearchSegment[];
  /** Required from, and only allowed from, the manifest's `views` processor. */
  views?: { card: CardView; detail: DetailView };
}

/**
 * A component module is evaluated in a sandboxed `srcdoc` iframe (opaque origin; CSP allows
 * no network, no WebAssembly, no workers). Its top level sees `magpie: ComponentHost`. It
 * learns facts about the original, such as its length, only through its view's `data`.
 */
export type ComponentModule = string;

// ---------------------------------------------------------------------------------------
// Host capabilities
// ---------------------------------------------------------------------------------------

export interface ByteRange {
  offset: number;
  length: number;
}

/** Lent to one processor run. Item, original, and grants come from the run, never arguments. */
export interface HostCapabilities {
  /** At most 8 MiB per call; read large originals in ranges. */
  readOriginal(range?: ByteRange): Promise<Uint8Array>;
  /** Stages an artifact for this run. The same name again in a retry replaces it. */
  putArtifact(name: ArtifactName, body: Uint8Array | string, mediaType: string): Promise<ArtifactAddress>;
  /** Service "transcribe", on this run's original. Memoized per tenant, original, and model. */
  transcribe(options: { model: string }): Promise<TranscriptCue[]>;
  /** Service "extract-frames". Memoized per tenant, original, and timestamp. */
  extractFrames(options: { at: number[] }): Promise<{ at: number; image: Uint8Array; mediaType: string }[]>;
  /** Service "describe-image". Memoized per tenant and image digest. */
  describeImage(options: { image: Uint8Array; mediaType: string }): Promise<{ text: string; model: string }>;
}

/** Lent to one component frame for the item on screen. Writes go through host chrome only. */
export interface ComponentHost {
  /** The view's `data` artifact, parsed as JSON. */
  getData(): Promise<unknown>;
  /** At most 1 MiB of the original or of one of this plugin's current artifacts. */
  read(ref: ContentRef, range: ByteRange): Promise<Uint8Array>;
  /** This plugin's selectors on the item. Annotation bodies stay in host chrome. */
  getAnnotations(): Promise<{ id: string; selector: PluginSelector }[]>;
  /** Opens the host's composer; the user saves there. The component cannot write. */
  proposeAnnotation(selector: PluginSelector): Promise<void>;
  /** Events sent before the first listener (such as a deep-link focus) are held for it. */
  onEvent(listener: (event: ComponentEvent) => void): void;
}

export type ComponentEvent =
  | { type: "annotations"; annotations: { id: string; selector: PluginSelector }[] }
  | { type: "focus"; selector: PluginSelector };

// ---------------------------------------------------------------------------------------
// Persisted data
// ---------------------------------------------------------------------------------------

// Regenerable output: one committed output per (item, plugin, processor) = its artifacts,
// search segments, and (for the views processor) views. Replaced only by a newer committed
// run; kept, frozen, when the plugin is removed.

export interface SearchSegment {
  text: string;
  /** Where a hit lands. Omit for item-level text such as a title. */
  target?: Selector;
}

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

export interface CardView {
  title: string;
  subtitle?: string;
  image?: ContentRef;
  badges?: string[];
}

export type DetailView = MediaView | RecordView | CustomView;

/** Host-standard formats: `cues` is {cues: TranscriptCue[]}; `thumbnails` is {frames: {at, image}[]}. */
export interface MediaView {
  template: "media";
  media: ContentRef;
  cues?: ArtifactAddress;
  thumbnails?: ArtifactAddress;
}

export interface RecordView {
  template: "record";
  fields: { label: string; value: string }[];
  lists?: { label: string; items: string[] }[];
}

export interface CustomView {
  template: "custom";
  component: ComponentName;
  data?: ArtifactAddress;
  /** Rendered when the component is unavailable: plugin removed or component missing. */
  fallback: MediaView | RecordView;
}

// Durable user data: annotations. Never written by plugins, never changed by reprocessing.

export interface Annotation {
  id: string;
  item: ItemId;
  /** The revision the user annotated. */
  revision: RevisionId;
  /** Most stable first. A transcript highlight is [time, text-quote]. */
  selectors: Selector[];
  note: string | null;
  createdAt: number;
}

export type Selector = TimeSelector | TextQuoteSelector | PluginSelector;

/** Seconds on the original media. Stable across re-transcription of the same revision. */
export interface TimeSelector {
  type: "time";
  start: number;
  end: number;
}

/** A quote in a host-standard text artifact. The host re-finds it after reprocessing. */
export interface TextQuoteSelector {
  type: "text-quote";
  in: ArtifactAddress;
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Opaque to the host. By convention it addresses the immutable original (e.g. a STEP entity
 * id), so reprocessing cannot invalidate it; the host cannot check this. `label` is what host
 * chrome shows when no component can place it.
 */
export interface PluginSelector {
  type: "plugin";
  plugin: PluginId;
  value: string;
  label: string;
}

/** Computed by the host on every read; never stored. */
export type AnchorState =
  | "exact" // every host-resolvable selector matches the current outputs
  | "text-changed" // the time range still holds, but its quote is no longer in the transcript
  | "orphaned" // cannot be placed; listed, never moved to a guessed location
  | "delegated"; // a plugin selector; only that plugin's component can place it
