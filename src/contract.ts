// The Magpie extension contract under test.
//
// Three kinds of declarations live here, and they are enforced in different places:
//   1. Plugin release: data a plugin ships. The host validates it at install time.
//   2. Plugin hooks: code the host invokes. Processors run in a Dynamic Worker with no
//      network and no bindings; components run in an opaque-origin sandboxed iframe.
//   3. Host capabilities and persisted data: what the host lends to one invocation, and
//      what it stores. Authority is checked by the host on every call, never by these types.

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

export type ItemId = string;
/** One immutable original of an item. A refetch or an authored edit creates a new revision. */
export type RevisionId = string;
export type RunId = string;
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
// 1. Plugin release
// ---------------------------------------------------------------------------------------

export interface PluginRelease {
  manifest: PluginManifest;
  /** ES modules for the processor isolate; `processor.js` is the main module. */
  processorModules: Record<string, string>;
  /** Browser modules, one per component, evaluated inside the component iframe. */
  componentModules?: Record<ComponentName, string>;
}

export interface PluginManifest {
  id: PluginId;
  version: string;
  /** Declarative; the host matches inputs without running plugin code. */
  recognizes: Recognizer[];
  /** Each processor produces one output that commits independently. Runs in this order. */
  processors: ProcessorName[];
  /** The processor whose output supplies the item's card and detail views. */
  views: ProcessorName;
  /** Host services the processors may call. Anything not listed is refused. */
  services: ServiceName[];
}

export interface Recognizer {
  mediaTypes?: string[]; // "video/webm" or "video/*"
  extensions?: string[]; // ".step"
  hosts?: string[]; // source URL hostnames, e.g. "www.youtube.com"
}

export type ServiceName = "transcribe" | "extract-frames" | "describe-image";

// ---------------------------------------------------------------------------------------
// 2. Plugin hooks
// ---------------------------------------------------------------------------------------

/** The default export of `processor.js` is a WorkerEntrypoint implementing this. */
export interface ProcessorEntrypoint {
  /**
   * `host` carries this run's authority and is valid only for this call. The isolate's env
   * is empty and its global fetch/connect throw.
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
  /** Exactly what becomes searchable for this output. Replaced atomically on reprocessing. */
  search?: SearchSegment[];
  /** Only the manifest's `views` processor may return views. */
  views?: { card: CardView; detail: DetailView };
}

export interface SearchSegment {
  text: string;
  /** Where a hit should land. Omit for item-level text such as a title. */
  target?: Selector;
}

/**
 * A browser component is a module evaluated in an iframe with an opaque origin, no network
 * (CSP connect-src/img-src/media-src limited to data:), and a single MessagePort to the host.
 * `host` is a proxy for ComponentHost; the module's top level receives it as `magpie`.
 */
export interface ComponentHost {
  /** The view's `data` artifact for this item, parsed as JSON. */
  getData(): Promise<unknown>;
  /** Byte range of the item's original or one of the plugin's current artifacts. */
  read(ref: ContentRef, range: ByteRange): Promise<Uint8Array>;
  /** Selectors only: annotation bodies stay in host chrome. */
  getAnnotations(): Promise<{ id: string; selector: PluginSelector }[]>;
  /** Opens the host's composer. The user saves in host chrome; the component cannot write. */
  proposeAnnotation(selector: PluginSelector): Promise<void>;
  /** Host-to-component notifications: annotations changed, or "show this target". */
  onEvent(listener: (event: ComponentEvent) => void): void;
}

export type ComponentEvent =
  | { type: "annotations"; annotations: { id: string; selector: PluginSelector }[] }
  | { type: "focus"; selector: PluginSelector };

// ---------------------------------------------------------------------------------------
// 3a. Host capabilities lent to one processor run
// ---------------------------------------------------------------------------------------

export interface ByteRange {
  offset: number;
  length: number;
}

export interface HostCapabilities {
  /** At most 8 MiB per call; read large originals in ranges. */
  readOriginal(range?: ByteRange): Promise<Uint8Array>;
  /** Stages an artifact for this run. Same name again in a retry replaces it. */
  putArtifact(name: ArtifactName, body: Uint8Array | string, mediaType: string): Promise<ArtifactAddress>;
  /** Service "transcribe": runs on this run's original. Memoized per tenant and original. */
  transcribe(options: { model: string }): Promise<TranscriptCue[]>;
  /** Service "extract-frames". Memoized per tenant, original, and timestamp. */
  extractFrames(options: { at: number[] }): Promise<{ at: number; image: Uint8Array; mediaType: string }[]>;
  /** Service "describe-image". Memoized per tenant and image digest. */
  describeImage(options: { image: Uint8Array; mediaType: string }): Promise<{ text: string; model: string }>;
}

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

// ---------------------------------------------------------------------------------------
// 3b. Views: data the host renders with its own templates
// ---------------------------------------------------------------------------------------

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
  /** Rendered when the component is unavailable: plugin removed, disabled, or failing. */
  fallback: MediaView | RecordView;
}

// ---------------------------------------------------------------------------------------
// 3c. Persisted user data: annotations
// ---------------------------------------------------------------------------------------

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
 * Opaque to the host. Must address the immutable original (e.g. a STEP entity id), not a
 * derived artifact, so reprocessing cannot invalidate it. `label` is what host chrome shows
 * when no component can resolve it.
 */
export interface PluginSelector {
  type: "plugin";
  plugin: PluginId;
  value: string;
  label: string;
}

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

/** Computed by the host on read; never stored. */
export type AnchorState =
  | "exact" // every host-resolvable selector matches the current outputs
  | "text-changed" // the time range still holds, but its quote is no longer in the transcript
  | "orphaned" // cannot be placed; shown in a list, never moved to a guessed location
  | "delegated"; // plugin selector; only the plugin's component can place it
