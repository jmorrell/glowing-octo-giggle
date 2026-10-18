# A small extension contract for Magpie

This repository derives and tests the smallest extension contract I can defend for Magpie
([jmorrell/stacks](https://github.com/jmorrell/stacks)): what a plugin may ship, what the host
lends it, and what the host stores. It is an experiment, not an implementation plan. Everything
runs locally: Workers code in workerd (the Workers Vitest integration and `wrangler dev`), real
Dynamic Worker isolates, and Chromium through Playwright. Paid and external services are mocked.

The contract is [`src/contract.ts`](src/contract.ts). The evidence behind it, with pinned
citations, is in [`docs/evidence.md`](docs/evidence.md).

**In short.** A plugin ships declarative recognizers, one or more *processors*, and optional
*components*. Each processor runs in a Dynamic Worker with no network and no bindings; it
receives one run's authority as an argument and returns search segments and views that the
host validates and commits atomically. Several processors per plugin let a video's transcript
appear even while frame descriptions fail. Views are data rendered by host templates; a
component (plugin browser code) runs in an opaque-origin iframe and can only *propose*
annotations, which host chrome saves. Annotations are user data anchored to the immutable
original where possible, so re-transcription changes their state but never moves or deletes them.

The checks pass, with one boundary that does not hold: in Chromium a sandboxed component can
still send data out over WebRTC. A component can therefore disclose whatever it is shown.

## 1. Evidence that changed or confirmed the design

Kinds of evidence are defined in [`docs/evidence.md`](docs/evidence.md#evidence): **source**,
**real** (real code run here on synthetic input), **recorded** (production API responses,
aggregates only), **docs**, **mocked**.

| Evidence | Kind | Effect on the design |
| --- | --- | --- |
| Items are identified by URL (`url NOT NULL`, unique); `saveLibraryItem` accepts only HTTP(S) URLs | source | Item identity is a host ID; URL is an optional input fact. Uploads and authored documents need it. |
| Handlers get the whole `Env` and global `fetch`, and are chosen by `(url, HEAD content type)` | source | Recognition is declarative and host-evaluated; processors get no ambient authority. |
| Output kinds are closed (`'html' \| 'pdf'`); one `original` and one `readable` artifact; presentation finds images by the names `thumbnail`/`favicon` | source, recorded | Outputs are many named artifacts at stable addresses; presentation is declared, not inferred from names. |
| Refresh deletes the current capture before rebuilding it; there are no annotations | source | Replace outputs only by atomic commit of a newer run; annotations live apart from outputs. |
| **E1:** FTS indexes Defuddle's HTML, so `href`, `src`, `https` match text no reader sees | real | Searchable text is an explicit output (segments), each with a target. |
| **E2:** the reader's sanitizer strips the YouTube handler's `<iframe>`; the item renders as a title | real | Processors do not emit markup for the host to filter; they fill template slots. |
| EmDash sandboxed plugins: Worker Loader, `globalOutbound: null`, a bridge binding; capability *names*, not per-record scope; UI is host-rendered Block Kit; React/Astro only for build-time "native" plugins | source | Confirmed host-mediated authority and declarations-first UI. Authority here is bound to one run, not to a capability name. |
| Cloudflare OS gadgets: arbitrary client code in a `srcdoc` iframe with CSP; shell sets `frame-src srcdoc:`; a TODO admits WebRTC/STUN is uncovered | source | Adopted the iframe model for custom components, and tested its stated limits. |
| Probe: a binding in a cached isolate's `env` keeps the **first** caller's `props` (run 2 acted as run 1) | real | Authority is passed as an argument to `process()`; env is empty; isolates are keyed by tenant and release. |
| Probe: `limits.cpuMs` is not enforced locally | real | CPU limits are untested; labelled as a production claim only. |
| 128 MB isolates, 1 MiB step results, 4 concurrent Dynamic Workers per request, no native tools | docs | Range reads, commit inside the step, render lists from stored data, host services for media work. |
| Removing transcription memoization makes the retry check fail (`expected 2 to be 1`) | real, mocked vendor | Paid host services are memoized by input before returning to the plugin. |
| Browser probes: WebRTC reached the STUN sink in both configurations; self-navigation leaked only without the host's `frame-src` | real (Chromium) | Components get least data; a component's publisher must be trusted with what it renders. |
| `ProcessResult.metadata` was stored but read by nothing | real | Removed. |

## 2. The contract

Exact signatures, condensed from [`src/contract.ts`](src/contract.ts) (comments there say what
each rule is and where it is enforced).

```ts
// ---- Plugin hooks: code the host invokes -------------------------------------------
interface PluginRelease {
  manifest: PluginManifest;
  processorModules: Record<string, string>;                // main module "processor.js"
  componentModules?: Record<ComponentName, ComponentModule>;
}
interface PluginManifest {
  id: PluginId;
  version: string;
  recognizes: Recognizer[];                                 // declarative; the host selects
  processors: ProcessorName[];                              // independent outputs, run in order
  views: ProcessorName;                                     // which output carries card/detail
  services: ServiceName[];                                  // grants; anything else is refused
}
interface Recognizer { mediaTypes?: string[]; extensions?: string[]; hosts?: string[] }
type ServiceName = "transcribe" | "extract-frames" | "describe-image";

interface ProcessorEntrypoint {                             // default export of processor.js
  process(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult>;
}
interface ProcessRequest { processor: ProcessorName; item: { id: ItemId; input: InputFacts }; original: OriginalFacts }
type InputFacts = { kind: "url"; url: string } | { kind: "capture"; url: string } | { kind: "upload"; filename: string } | { kind: "authored" };
interface OriginalFacts { revision: RevisionId; mediaType: string; byteLength: number; sha256: string }
interface ProcessResult { search?: SearchSegment[]; views?: { card: CardView; detail: DetailView } }
type ComponentModule = string;                              // evaluated in the frame with `magpie: ComponentHost`

// ---- Host capabilities: lent to one invocation ---------------------------------------
interface ByteRange { offset: number; length: number }
interface HostCapabilities {                                // one processor run
  readOriginal(range?: ByteRange): Promise<Uint8Array>;    // ≤ 8 MiB per call
  putArtifact(name: ArtifactName, body: Uint8Array | string, mediaType: string): Promise<ArtifactAddress>;
  transcribe(options: { model: string }): Promise<TranscriptCue[]>;
  extractFrames(options: { at: number[] }): Promise<{ at: number; image: Uint8Array; mediaType: string }[]>;
  describeImage(options: { image: Uint8Array; mediaType: string }): Promise<{ text: string; model: string }>;
}
interface ComponentHost {                                   // one component frame
  getData(): Promise<unknown>;
  read(ref: ContentRef, range: ByteRange): Promise<Uint8Array>;                 // ≤ 1 MiB per call
  getAnnotations(): Promise<{ id: string; selector: PluginSelector }[]>;
  proposeAnnotation(selector: PluginSelector): Promise<void>;                   // host chrome saves
  onEvent(listener: (event: ComponentEvent) => void): void;                     // early events held
}
type ComponentEvent =
  | { type: "annotations"; annotations: { id: string; selector: PluginSelector }[] }
  | { type: "focus"; selector: PluginSelector };

// ---- Persisted data: what the host stores and renders --------------------------------
type ArtifactAddress = { processor: ProcessorName; name: ArtifactName };      // stable across runs
type ContentRef = "original" | ArtifactAddress;
interface SearchSegment { text: string; target?: Selector }
interface TranscriptCue { start: number; end: number; text: string }          // host-standard cues
interface CardView { title: string; subtitle?: string; image?: ContentRef; badges?: string[] }
interface MediaView { template: "media"; media: ContentRef; cues?: ArtifactAddress; thumbnails?: ArtifactAddress }
interface RecordView { template: "record"; fields: { label: string; value: string }[]; lists?: { label: string; items: string[] }[] }
interface CustomView { template: "custom"; component: ComponentName; data?: ArtifactAddress; fallback: MediaView | RecordView }
type DetailView = MediaView | RecordView | CustomView;

interface Annotation { id: string; item: ItemId; revision: RevisionId; selectors: Selector[]; note: string | null; createdAt: number }
type Selector = TimeSelector | TextQuoteSelector | PluginSelector;
interface TimeSelector { type: "time"; start: number; end: number }              // seconds on the original
interface TextQuoteSelector { type: "text-quote"; in: ArtifactAddress; exact: string; prefix?: string; suffix?: string }
interface PluginSelector { type: "plugin"; plugin: PluginId; value: string; label: string } // opaque to the host
type AnchorState = "exact" | "text-changed" | "orphaned" | "delegated";       // computed on read
```

### What earns each extension point

| Extension point | Kind | Requirement that earns it | Shown by |
| --- | --- | --- | --- |
| `Recognizer` | hook (data) | Choose a plugin per item without running code; Magpie already selects by URL host and type | `select.ts`; `hosts` untested here |
| `processors[]` (independent outputs) | hook | A failed frame description must not hide a paid transcript | partial-failure check |
| `views` processor | hook | One place for item-specific card and detail data | all scenarios |
| `process(request, host)` | hook | Per-run authority that survives isolate caching | unauthorized-access checks, probe |
| `readOriginal(range)` | capability | Inspect large originals without loading them (128 MB) | video header check, Parquet |
| `putArtifact` | capability | Several related assets per output, named and staged per run | video, CAD, Parquet |
| `transcribe`, `extractFrames`, `describeImage` | capability | Media work cannot run in an isolate; paid work must not repeat | retry check, mutation |
| `SearchSegment.target` | data | Hits land on a time range or a part, and only from current outputs | reprocessing check, CAD search link |
| `ArtifactAddress` | data | Late binding across processors (card image from frames) and stable quote targets | partial-failure, removal, reprocessing checks |
| `media` / `record` templates | data | Synchronized playback and highlights; fallback after removal | media-template, removal checks |
| `custom` + `ComponentHost` | hook + capability | A CAD part picker and a Parquet scan no fixed template can express | custom-component, Parquet checks |
| `time` / `text-quote` selectors | data | Highlights that survive re-transcription, or orphan visibly | reprocessing check |
| `plugin` selector with `label` | data | Locations only the plugin understands; legible after removal | removal check (CAD) |

**Removed or never added**, because no experiment needed them: processor `metadata`; dependencies
between processors (memoized services made them unnecessary for video); processor reads of other
outputs; a text-position selector (prefix/suffix plus "orphan when ambiguous" sufficed); plugin
key-value storage; plugin network access; an event bus or hooks on item changes; plugin code at
list-render time; component write access.

## 3. Lifecycle, ownership, and enforcement

**Identity.** An *item* has a host ID. Its *original* is a revision: immutable bytes plus
SHA-256, media type, and length; authored edits or refetches would add revisions. A *run* pins
`(item, revision, plugin release digest, processor)`. A *derived artifact* is addressed as
`(processor, name)` within the item's plugin, and served from run-scoped URLs that never change
content. An *annotation target* is `(item, revision, selectors[])`, most stable selector first.

| Boundary | Owner; who may change it | Becomes visible | After failure or retry | Survives reprocess / upgrade / removal | Authority crossing it; enforced by |
| --- | --- | --- | --- | --- | --- |
| Recognition | Host decides from the manifest | At save | — | Item keeps its plugin; removal keeps outputs | Manifest data only; `select.ts` |
| Processor run | Host creates and pins; plugin computes | Never directly | Workflow retries the same run; staged artifacts reuse names | Upgrade or removal rejects in-flight runs | `host` stub for one run; `PluginHost` re-checks the run on every call; no network (`globalOutbound: null`) |
| Host services | Host; plugin may call if granted | Through outputs | Result memoized before return: a retry does not pay again | Memo kept per tenant | Grant list; `transcribe`/`extractFrames` act on the run's original, never plugin-named input |
| Output commit | Host; replaced only by a newer committed run of the same processor | Atomically, per processor | Failed or rejected run discards its staged artifacts; previous output stays | Reprocess replaces; upgrade replaces on reprocess; removal freezes | `Library.commitRun` validates and checks run is current, release installed, item and revision current |
| Search | Host indexes plugin-chosen segments | With their output | Only committed outputs have segments | Replaced with the output; kept after removal | Validated targets; FTS input quoted |
| Templates | Host code renders plugin data as text and host URLs | With the views output | Missing outputs leave empty slots | Render from stored outputs after removal | No markup or URLs in views; artifacts served inert (`sandbox` CSP, `nosniff`) |
| Component | Plugin code in an opaque-origin frame | When loaded | Falls back to its declared template | Removal or a missing component means fallback | One `MessagePort`; host page validates every call; frame CSP; host page `frame-src` |
| Annotations | The user, through host chrome or their own API calls; never a plugin | At save | — | Never changed by processing; state recomputed on read | Item-scoped API; component may only propose |

**Durable versus regenerable.** Originals and annotations are durable user data. Outputs are
regenerable *while their plugin is installed*, but regeneration may cost money (transcription)
or give different results (models), so the host keeps the current output until a replacement
commits, keeps memoized service results, and keeps a removed plugin's outputs as they are.

**Selection and composition.** One plugin per item: the most specific recognizer wins, ties
break by plugin ID, and runners-up are recorded as `alternatives`. Recognition, processing,
and item-specific views come from one release; host templates render host-standard formats
(cues, thumbnails, records) whoever produced them, which is what keeps items readable after
removal. There is no cross-plugin composition.

**Minimum authority the experiments needed.** Backend and frontend are contained separately.

| | Object access | External requests | Credentials | User actions |
| --- | --- | --- | --- | --- |
| Video processors | Read this run's original by range; stage this run's artifacts | None from the plugin; the host calls the (mocked) vendor | None in the isolate; the host would hold vendor keys | None |
| CAD and Parquet processors | Same | None | None | None |
| CAD component | Its view's data artifact; this plugin's selectors on this item | None (CSP `connect-src 'none'`) | None (opaque origin: no cookies or storage) | Propose a location; the user writes and saves the note in host chrome |
| Parquet component | Ranged reads of this item's original, ≤ 1 MiB per call | None | None | None |

### Templates versus a component, for the interaction that matters

All five scenarios attach notes to locations, and that is the one write that crosses the
presentation boundary, so it is the interaction compared:

| | Host template (video) | Isolated component (CAD) |
| --- | --- | --- |
| Who understands the location | The host: time ranges and quotes | Only the plugin: `{ value: "#10", label }` |
| Selection → annotation | Host reads the selection and saves `[time, text-quote]` | Component proposes a selector; host chrome collects and saves the note |
| Placing it later, after reprocessing | Host re-resolves it (`exact`, `text-changed`, `orphaned`) | Host cannot; it is `delegated` to the component |
| Following a search hit | Host seeks to `#t=` | Host sends a `focus` event to the component |
| After the plugin is removed | Unchanged | `record` fallback; notes listed by label |
| Price | A template per kind of location | Frame, port protocol, held events, CSP; WebRTC gap |
| Check | [`browser/media-template.spec.ts`](browser/media-template.spec.ts) | [`browser/custom-component.spec.ts`](browser/custom-component.spec.ts) |

The narrowest experiment for the component boundary needs a selectable location, a proposal
channel, and host persistence, not geometry. The CAD viewer therefore draws one box per part;
a real 3D viewer would add rendering risk without testing the boundary further.

## 4. Experiments

### Uncertainties registered before implementation

| # | Uncertainty | Smallest experiment | Observation that would disprove the design | Result |
| --- | --- | --- | --- | --- |
| U1 | Can derived output be replaced without breaking annotations and search? | Re-transcribe with a model that segments and words speech differently; read annotation states and search targets | A highlight silently moves; survival needs plugin code; a hit points into a superseded output | **Held.** Time-anchored highlight → `text-changed` at 4–9 s; unplaceable quote → `orphaned`; old-only words stop matching; targets come from current outputs. Notes unchanged. |
| U2 | Can each output fail and retry independently without repeating paid work, and can authority be revoked mid-run? | Real Workflow + Dynamic Worker; fail storage once after transcription; vision outage; supersede, upgrade, and remove during runs | Transcription paid twice; one failure hides committed outputs; a stale or revoked run commits | **Held** (CPU limits untested). Transcribe called once across a retried step; frame outage left media and transcript visible; stale, upgraded, and removed runs could neither act nor commit. |
| U3 | Can an isolated component support "attach a note to a meaningful location" without being able to write, read other data, or send data out? | CAD stand-in viewer in an opaque-origin iframe; host composer; a hostile probe component and an HTTP + UDP sink | The component writes or reads host data; the interaction needs same-origin code; data reaches the sink | **Partly disproved.** Interaction and integrity hold. Confidentiality does not: WebRTC reached the sink in both configurations. Self-navigation leaked only without `frame-src`. |

### Behavioral checks

| Check | File | Failure it prevents |
| --- | --- | --- |
| No network, bindings, ungranted services, unsafe artifacts, or host internals | [`test/unauthorized-access.spec.ts`](test/unauthorized-access.spec.ts) | A processor exceeding its run |
| A run's capability is dead in the next run; same release in two tenants reads only its own originals | same | Cross-item or cross-tenant reads through a shared isolate |
| Results naming undeclared processors or another plugin's selectors are rejected | same | Plugin output reaching other plugins' data |
| Upgraded or removed plugin: in-flight run can neither act nor commit | same | Revoked code acting under an old grant |
| Retry after failure pays for transcription once | [`test/partial-failure-and-retry.spec.ts`](test/partial-failure-and-retry.spec.ts) | Repeated paid work |
| A failed derivative leaves committed outputs visible; reprocessing it later reuses memoized frames | same | One failure hiding the item |
| Previous output served while a replacement runs and after it fails; superseded run cannot commit | same | Reprocessing blanking an item |
| Re-transcription keeps time anchors, flags changed text, orphans unplaceable quotes; search only from current output | [`test/reprocessing-and-targets.spec.ts`](test/reprocessing-and-targets.spec.ts) | Annotations or hits pointing at the wrong place |
| Removal keeps template views, artifacts, search, and notes; stops processing; components fall back | [`test/plugin-removal.spec.ts`](test/plugin-removal.spec.ts) | Uninstall destroying user content |
| Parquet: selective reads; only chosen values indexed | [`test/parquet-challenge.spec.ts`](test/parquet-challenge.spec.ts) | Whole-file reads; indexing row data |
| Annotate a part from inside the component; host chrome saves; markers survive reload | [`browser/custom-component.spec.ts`](browser/custom-component.spec.ts) | Components needing write access |
| A search hit opens the component focused on its part | same | Plugin targets that cannot be followed |
| Containment probes, with and without the host page CSP | same | Unknown exfiltration channels |
| Cue click seeks; selection → highlight; after re-transcription it spans the new cues | [`browser/media-template.spec.ts`](browser/media-template.spec.ts) | Template interaction regressing |
| A component scans one Parquet column through ranged host reads | [`browser/parquet-challenge.spec.ts`](browser/parquet-challenge.spec.ts) | Components needing network or whole files |

### Reproduce

Node 24 and npm; Playwright's Chromium (`npx playwright install chromium` if missing).

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:browser
```

```bash
node evidence/stacks/run.mjs ~/workspace/stacks/app
```

`npm test` runs 12 checks in workerd (about 1 s); `npm run test:browser` starts `wrangler dev`
with fresh local state and runs 6 checks (about 10 s). The last command runs E1 and E2 against a
Magpie checkout with its own `node_modules`. To explore the UI, run `npm run dev`, then
`node scripts/seed-dev.mjs`, and open http://127.0.0.1:8799.

### Observed results (17 October 2026, macOS, local workerd 2026-09-26/30, Playwright 1.63 Chromium)

- All 12 Vitest and 6 Playwright checks pass; `tsc` is clean.
- Paid work: transcribe 1 call across a retried step (2 with the memo removed). Vision outage:
  frame extraction 3 calls over three attempts (memoized), descriptions 3 failed calls; after
  recovery, frames 3 (no new calls) and descriptions 6.
- Component probes (both configurations): `fetch` to host and sink, parent DOM, cookies,
  `localStorage`, image beacon, host media, popup, top navigation, WebAssembly, and Workers were
  all refused. WebRTC sent 3 UDP datagrams to the local STUN sink. Self-navigation reached the
  sink only without the host page CSP. The frame can read its parent's URL (`document.baseURI`).
- Parquet (1,539,258 bytes): the processor read 407,169 bytes (26.5%); the footer, schema, and
  small string column took about 18 KB, and the 5-row preview the rest, because the file has no
  page index. The component's filtered scan of one row group requested 143,949 bytes (9.4%) and
  matched DuckDB's answer (169.88).

### Mocked, untested, and limits

- **Mocked:** transcription, frame extraction, and image description (`src/host/vendor.ts`),
  including outages and call counts. Fixtures are synthetic ([`fixtures/README.md`](fixtures/README.md)).
- **Not modeled:** authentication (a tenant header stands in), install consent, plugin
  distribution, URL saves and page capture, authored documents, MCP, offline, the `document`
  template, and a real 3D viewer (the CAD component draws boxes).
- **Untested:** CPU and subrequest limits (not enforced locally), production Dynamic Worker
  behavior (including whether cached isolates keep `env` the same way), browsers other than
  Chromium, DuckDB-WASM, large originals (uploads are capped at 50 MiB; artifacts are buffered,
  ≤ 25 MiB), concurrent processors, and the `hosts` recognizer.
- Under `wrangler dev` (not the Vitest pool), each Workflow that loads a Dynamic Worker logs one
  "code had hung" error after it returns; outputs still commit. Cause unknown.
- The text-quote rule is strict: exact match, unique, matching context. Whitespace is
  normalized; nothing fuzzier is tried, so some recoverable highlights will orphan.
- Known gaps left open: an artifact write that lands after its run was rejected is not queued
  for cleanup (Magpie's own artifact code handles this case); component calls are limited in
  size, not in rate; host-standard files are checked when read, not when committed.

## 5. The five scenarios against the contract

| Scenario | Input and recognition | Processors → outputs | Search | Presentation | Annotations | Built here? |
| --- | --- | --- | --- | --- | --- | --- |
| **Video** | Upload, `video/webm` | `media` (views), `transcript` (cues), `frames` (thumbnails, descriptions) | Cues and descriptions, each targeting a time range | `media` template: player, cues, thumbnails, seek sync | `[time, text-quote]`; survive re-transcription | End-to-end slice |
| **CAD** | Upload, `.step` | `model`: parts, record fallback | Part names targeting plugin selectors | `custom` viewer; `record` fallback | Plugin selector `{value: "#10", label}`; `delegated` | Second scenario |
| **Parquet** | Upload, `.parquet` | `schema`: columns, ranges, small distinct values, preview | Schema and chosen values; never rows | `custom` scanner; `record` fallback | None tested; would be plugin selectors | Challenge |
| **Recipes** | URL or captured page, `text/html` | Would be `recipe` (structured) + readable source | Ingredients and steps, quote targets into the source | `record` + a `document` template | Adaptations as `text-quote` notes on the source | Paper only |
| **Agent documents** | Created through MCP; `authored` input | Would be a Markdown renderer | Rendered text | `document` template | `text-quote` across revisions | Paper only |

**Awkward fits.**

- *Video.* Highlights are as precise as cues: a selection inside a cue stores the whole cue's
  time range. Archiving media from a URL needs a host acquisition service (no yt-dlp or ffmpeg in
  an isolate). A new revision (re-encoded file) makes time anchors untrustworthy; they then fall
  back to quotes (by rule; untested, since this host has no revision API). A custom player is
  impractical: the frame cannot load host media, so playback belongs to the template.
- *CAD.* The host cannot check that a plugin selector addresses the original; that is a
  convention. A new CAD revision orphans every part annotation (by rule; untested), because
  entity IDs need not survive an edit; carrying them over needs a plugin re-anchoring hook the
  contract lacks. Real STEP files exceed 8 MiB per read and 128 MB per isolate, and tessellation
  would need a host service. WebGL inside the frame is untested. Discovered while building it:
  a deep-link "focus" pushed before the component subscribed was lost; the host now holds early
  events.
- *Parquet.* Fits without host changes for a pure-JavaScript reader, with one undocumented
  convention: the component learns the file length from its own data artifact. DuckDB-WASM would
  need host changes: `'wasm-unsafe-eval'` and worker permissions in the frame CSP, and a channel
  for binary component assets (components are strings inlined into `srcdoc`). Selectivity
  depends on file layout and library defaults (hyparquet prefetches 512 KiB for the footer).
- *Recipes.* Recognition is the problem: a recipe is an HTML page with recipe JSON-LD, which a
  declarative recognizer cannot see, and HTML pages belong to the generic page plugin. One plugin
  per item means either the user chooses, or the contract grows content-based recognition or a
  second processor per item. Showing adaptations inline in the ingredient list would need record
  items to carry their own quote anchors (a small template change).
- *Agent documents.* The original changes: each edit is a new revision, created with a
  revision check, so quotes must be re-found across revisions and plugin selectors orphan. The
  `document` template (Magpie's sanitized reader) is assumed, not built here; E2 shows it is not
  a place for embedded media.

## 6. The strongest simpler alternative

**One processor per plugin, rendered only by host templates** — EmDash's sandboxed model with
Magpie's current handler shape. It deletes `processors[]`, the `views` designation, cross-output
addresses, components, `ComponentHost`, and the iframe host: roughly half the contract, and the
part with the containment gap.

I rejected it for two observed reasons. With a single output, the partial-failure check
cannot pass as written: either a vision outage hides a transcript that was already paid for
until every derivative succeeds, or each plugin must catch failures and commit a partial output
that the host cannot tell from a complete one, and cannot retry only the missing part. With
templates only, the CAD part picker and the Parquet scan cannot be expressed
unless the host ships a CAD viewer and a query engine; what remains is exactly the `record`
fallback the removal check shows.

I would reconsider if any of these became true:

- The WebRTC gap cannot be closed, so every component publisher must be trusted with the item
  anyway. Then a reviewed, same-origin component (EmDash's "native" tier) is simpler than the
  iframe protocol and gives up little.
- A host glTF viewer and a table or chart template cover what people actually do with CAD and
  Parquet items.
- Derivatives arrive from one provider call, so separate outputs no longer fail separately.

The roadmap's nearer-term path, trusted built-in handlers, is compatible: built-ins can
implement `ProcessorEntrypoint` against an in-process host first, and adopt the data model
(outputs, segments, views, annotations) before any plugin code is isolated.

## Repository map

| Path | What |
| --- | --- |
| [`src/contract.ts`](src/contract.ts) | The contract |
| [`src/host/`](src/host) | Worker API, `Library` Durable Object, Workflow, `PluginHost`, validation, anchors, templates, component host, mocked vendor |
| [`src/plugins/`](src/plugins) | Video, CAD (with viewer), Parquet (with scanner), and test-only hostile plugins |
| [`test/`](test), [`browser/`](browser) | Vitest checks in workerd; Playwright checks against `wrangler dev` |
| [`evidence/stacks/run.mjs`](evidence/stacks/run.mjs) | E1 and E2 against Magpie's code |
| [`docs/evidence.md`](docs/evidence.md) | Save trace, assumptions, prior-art verification, runtime constraints |
