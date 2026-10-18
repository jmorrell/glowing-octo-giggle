# Evidence

Everything the contract rests on, with its source and kind. Collected 17 October 2026.

| Label | Meaning |
| --- | --- |
| **source** | Read in pinned source code |
| **real** | Real code executed here, on synthetic input |
| **recorded** | Production API responses captured on 16 October 2026 into `~/workspace/magpie-design` by Jeremy's scripts. Only aggregate counts are reported; the responses are not committed (this repository is public). |
| **synthetic** | Fixtures made for these experiments |
| **mocked** | Controlled stand-ins for paid or external services |
| **docs** | Cloudflare documentation, accessed 17 October 2026 |

Pinned sources:

- Magpie: [`jmorrell/stacks@2ed9842`][stacks] (`origin/main`). The local checkout was on `codex/domain-migration-machinery`; I read `origin/main` through `git archive` and changed nothing in the checkout.
- Prior research: [jmorrell/stacks#270](https://github.com/jmorrell/stacks/pull/270), used as a map. Claims below were re-checked in the pinned prior-art source, not taken from the report.
- EmDash: [`emdash-cms/emdash@30604dc`][emdash] (the snapshot #270 used).
- Cloudflare OS: [`cloudflare/cloudflare-os@8060cd9`][cfos] (HEAD on 17 October 2026).

No production access was used. No observation here comes from a live Magpie or a deployed Dynamic Worker.

## 1. One save, traced through Magpie

A URL save (or a bookmarklet capture, which adds an HTML snapshot) follows this path. All **source**.

| Stage | What happens | Where |
| --- | --- | --- |
| Submission | `saveLibraryItem({ url, htmlSnapshot? })` accepts only a valid HTTP(S) URL. There is no upload or authored-document input. | [`jsonrpc.ts` 254-277][rpc-save], [`magpie-service.ts` 202-205][svc-save] |
| Identity | The tenant's `TenantLibrary` Durable Object deduplicates by URL. `library_item.url` is `NOT NULL` with a unique index. | [`tenant-library.ts` 93-127][upsert], [`tenant-library.sql` 61-70, 155][sql-item] |
| Capture | One `library_item_capture` row per item (unique index); a snapshot is stored as artifact `original` before the Workflow starts. | [`tenant-library.ts` 189-228][start-capture], [`tenant-library.sql` 150][sql-one-capture] |
| Content type | A `HEAD` request (curl User-Agent), following redirects. Snapshots are hard-coded `text/html`. | [`save-library-item.ts` 86-88, 258-282][wf-head] |
| Selection | The first of five handlers whose `shouldHandle(url, contentType)` matches; otherwise HTML, unless the type is not HTML/PDF. | [`content-fetch/index.ts` 49-70][select] |
| Processing | `handle(env, url, libraryItemId, contentType, htmlSource?)` receives the whole Worker `Env` and ambient `fetch`. It returns bytes inline and a fixed metadata shape (`meta: null`). | [`content-handler.ts` 3-24][handler], [`index.ts` 12-47][result] |
| Persistence | One Workflow step (5 retries) runs the handler and writes artifacts named `original` and `readable`; images are fetched in a later step and stored by name. | [`save-library-item.ts` 96-174, 195-228][wf-step] |
| Visibility | `completeCapture` inserts details and flips the capture to `success` in one transaction; tags are added after it; image descriptions run after the item is visible. | [`tenant-library.ts` 350-395][complete], [`save-library-item.ts` 242-254][wf-describe] |
| Indexing | SQL triggers copy `title`, `text_content`, `site_name` from capture details into FTS5. For HTML, `text_content` is Defuddle's **HTML**. | [`tenant-library.sql` 5-59, 105-111][sql-fts], [`html-handler.ts` 110][html-text] |
| Rendering | The reader loads the artifact named `readable` and sanitizes it with `sanitize-html` defaults plus `img`. With no readable artifact (PDFs) it shows "A readable version is not available". | [`tenant-library.ts` 588-603][readable-join], [`jsonrpc.ts` 357-392][rpc-readable], [`+page.server.ts` 32-59][sanitize], [`+page.svelte` 185][no-readable] |
| List | The card finds images named `thumbnail` and `favicon`. | [`LibraryCard.svelte` 130-162][card] |
| Annotations | None: no table, type, or API. The roadmap defines the intended concept. | [`MAGPIE-ROADMAP.md` 94-102][roadmap-model] |
| Refresh | Queues the current capture's artifacts for deletion, deletes its details and capture, then starts a new capture. A failed refresh leaves no readable version. | [`tenant-library.ts` 142-187][refresh] |

### Assumptions outside `ContentHandler` that constrain extensibility

| Assumption | Where it lives | Consequence for an extension contract |
| --- | --- | --- |
| An item is a URL | Schema, `upsertLibraryItem`, `saveLibraryItem` validation | Uploads and agent-authored documents have no place to go. Identity must not depend on a URL. |
| Recognition = `(url, HEAD content type)` | Workflow + `getContentHandler` | A handler cannot see bytes or a filename. Snapshots are always "HTML". Types outside HTML/PDF are rejected before any handler is asked. |
| Output kinds are closed | `type CHECK (type IN ('html','pdf'))`, API `type: "html" \| "pdf"` | A new format needs a schema migration and an API change. |
| One original, one readable | Artifact names `original`/`readable` in the Workflow and the readable join | A video's several related assets, a CAD viewer mesh, or a Parquet preview have no slot. |
| Presentation by image **name** | `thumbnail`/`favicon` in the [card][card]; `favicon` excluded from [AI description][describe] | An undocumented naming convention is already the presentation contract. |
| Search text = whatever `textContent` holds | FTS triggers | Nothing chooses what is searchable, and hits resolve only to an item, never to a location. |
| One sanitizer for all output | Svelte reader | Handler output is filtered by rules the handler cannot see (experiment E2). |
| Refresh destroys before it rebuilds | `refreshLibraryItem` | No previous version survives to anchor annotations to, or to fall back on. |
| Handlers hold ambient authority | `handle(env, …)`, global `fetch` | Every handler is trusted code; there is nothing to enforce. |
| Retries repeat everything | One step runs fetch + handler + upload | Paid calls inside a handler would repeat on retry. |

### Experiments on Magpie's own code (`evidence/stacks/run.mjs`)

Real handler, sanitizer-options, and schema code from `2ed9842`, bundled and run in Node on synthetic inputs. Reproduce with `node evidence/stacks/run.mjs <stacks>/app` (needs that checkout's `node_modules`).

- **E1 — search indexes markup (real).** A captured page whose visible text never contains "href", "src", or "https" matches all three, because `text_content` is HTML. The content snippet for `href` is `...p><p>See the <a <mark>href</mark>="https://example.org/report">inspection report...`.
- **E2 — the reader drops handler output (real).** The YouTube handler stores readable HTML with an `<iframe>` embed; the reader's sanitizer options remove it. What renders is the text `Synthetic video Synthetic video By Author`.

Both say the same thing: a processor's output is shaped by host code it does not know about. In the contract, searchable text and presentation are explicit outputs that the host renders with declared templates.

### Representative persisted outputs (recorded, aggregate only)

From one `listLibraryItems` response (30 of 2,336 items) and one readable-content response:

- 29 successful items, all `type: "html"`: 20 `HtmlHandler`, 8 `TwitterHandler`, 1 `YoutubeHandler`; 1 failed capture.
- Image names: 108 `article-*`, 18 `favicon`, 14 `thumbnail`; 56 images carry an AI description.
- Tags exist only where handlers add them (`Twitter`, `social media`, `YouTube`, `video`).
- The readable HTML (~80 KB) uses ordinary article markup plus `data-ai-description` attributes.

Magpie's own tests use synthetic inputs throughout (handlers are called with stubbed `fetch`). No raw production inputs were available or needed.

## 2. Prior art, verified in pinned source

### EmDash (`30604dc`)

| Mechanism | Status | Source |
| --- | --- | --- |
| Sandboxed plugin code runs from Worker Loader with `globalOutbound: null` and only a `BRIDGE` binding whose props carry plugin ID, version, capabilities, and allowed hosts | implemented | [`runner.ts` 349-405][em-runner] |
| The isolate is cached under `plugin id:version`; bridge props are per plugin, not per request or record | implemented | [`runner.ts` 329-330][em-name] |
| Bridge checks capability **names** (e.g. `content:read`) and then serves any collection/ID | implemented | [`bridge.ts` 935-950][em-bridge] |
| Sandboxed admin UI is Block Kit JSON rendered by a fixed host switch; no plugin markup or iframe is rendered | implemented | [`renderer.tsx` 21-125][em-renderer] |
| React admin pages and Astro components are allowed only for "native" plugins, installed at build time, rejected in `sandboxed: []` | implemented | [`integration/index.ts` 552-585][em-native] |

**Frontend model:** host-rendered declarations for sandboxed plugins; trusted same-origin components for native plugins. EmDash ships no way to run untrusted plugin code in the browser.

### Cloudflare OS (`8060cd9`)

| Mechanism | Status | Source |
| --- | --- | --- |
| Gadget server code loads through `env.LOADER.get(\`${ctx.id}.${codeVersion}.${gadgetId}\`, …)` with `globalOutbound: null`; env holds only loopback bindings minted by the host | implemented | [`overseer.ts` 4447-4510][os-loader], [`overseer.ts` 2525-2537][os-env] |
| Each gadget runs as a Durable Object facet with its own storage | implemented | [`overseer.ts` 4581-4588][os-facet] |
| Gadget **client code is arbitrary**: it runs in a `srcdoc` iframe with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` and CSP `default-src 'none'; connect-src 'none'; img-src data:; media-src data:` | implemented | [`GadgetUI.tsx` 105-116][os-csp], [`GadgetUI.tsx` 507-518][os-iframe] |
| The frame's only channel is a Cap'n Web session over a `MessagePort`; the shell accepts it only from its own frame at origin `"null"` | implemented | [`GadgetUI.tsx` 25-33, 340-352][os-handshake] |
| The shell sets `frame-src srcdoc:` to stop gadget frames navigating away ("DO NOT REMOVE") | implemented | [`index.html` 7-8][os-shell] |
| "CSP and request interception do not cover WebRTC/STUN. The same gap exists for Gadgets." | known gap (TODO) | [`browser-export.ts` 37-39][os-webrtc] |
| Gadgets are sandboxed "to the maximum extent allowed by browsers" | documented promise | [`README.md`][os-readme] |

**Frontend model:** arbitrary plugin code, isolated by an opaque-origin iframe and CSP, with an RPC channel. My browser experiment reproduced both of its stated limits independently (self-navigation without `frame-src`; WebRTC).

## 3. What runs inside a Dynamic Worker, and what must be a host service

| Constraint | Value | Kind | Consequence |
| --- | --- | --- | --- |
| Network | `globalOutbound: null` makes `fetch` and `connect` throw | docs + **real** probe | Any external request must be a host capability. |
| Bindings | `env` is whatever the loader passes; RPC stubs and `ctx.exports` loopbacks with `props` are allowed | docs + **real** probe | Authority can be an object the host mints. |
| Cached isolate env | With `LOADER.get(id, …)`, a binding in `env` keeps the **first** caller's `props`: run 2 executed as run 1 | **real** probe (local workerd 2026-09-26) | Per-run authority cannot live in `env`. It is passed as an argument to `process()`. |
| Stashed capability | A host stub kept in a global and used in a later request fails: "Cannot perform I/O on behalf of a different request" | **real** probe and test | A run's authority ends with its call. |
| CPU limit | `limits: { cpuMs: 50 }` did **not** stop a 2-second busy loop locally | **real** probe | CPU limits are untested here; production enforcement is a documented claim only. |
| Concurrency | 4 distinct Dynamic Workers in flight per request, 10 per Durable Object | docs | Do not call plugin code per list card; render stored declarations. |
| Memory | 128 MB per isolate, including WebAssembly | docs | Large media, CAD kernels, or whole Parquet files cannot be loaded into a processor. Read by range; delegate heavy work. |
| Workflow step result | 1 MiB | docs | Results are committed inside the step, not returned through it. |
| Workflow step CPU | 30 s default, 5 min maximum; wall time unlimited | docs | Waiting on a host service is fine; computing a transcript in-isolate is not. |
| Native tools | No ffmpeg, yt-dlp, Whisper, headless browser, or CAD kernel in an isolate | runtime model | Media acquisition, frame extraction, transcription, rendering pages, and tessellation are host services (mocked here). |
| Local dev quirk | Under `wrangler dev`, each Workflow that loads a Dynamic Worker logs one "code had hung" error after `run()` returns; outputs still commit; absent in the Vitest pool and in Workflows that load no isolate | **real**, unexplained | Not investigated further; does not affect any result. |

[stacks]: https://github.com/jmorrell/stacks/tree/2ed98425da3ffd4715776134027af7103c050ca6
[rpc-save]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/api/jsonrpc.ts#L254-L277
[svc-save]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/magpie-service.ts#L202-L205
[upsert]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.ts#L93-L127
[sql-item]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.sql#L61-L70
[start-capture]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.ts#L189-L228
[sql-one-capture]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.sql#L150
[wf-head]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/workflows/save-library-item/save-library-item.ts#L86-L88
[select]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/content-fetch/index.ts#L49-L70
[handler]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/content-fetch/content-handler.ts#L3-L24
[result]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/content-fetch/index.ts#L12-L47
[wf-step]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/workflows/save-library-item/save-library-item.ts#L96-L174
[complete]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.ts#L350-L395
[wf-describe]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/workflows/save-library-item/save-library-item.ts#L242-L254
[sql-fts]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.sql#L5-L59
[html-text]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/content-fetch/content-handlers/html-handler.ts#L110
[readable-join]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.ts#L588-L603
[rpc-readable]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/api/jsonrpc.ts#L357-L392
[sanitize]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/svelte/src/routes/library/%5Bid%5D/%2Bpage.server.ts#L32-L59
[no-readable]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/svelte/src/routes/library/%5Bid%5D/%2Bpage.svelte#L185
[card]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/svelte/src/lib/components/LibraryCard.svelte#L130-L162
[roadmap-model]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/docs/MAGPIE-ROADMAP.md#L94-L102
[describe]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/content-fetch/image-description.ts#L6-L15
[refresh]: https://github.com/jmorrell/stacks/blob/2ed98425da3ffd4715776134027af7103c050ca6/app/src/server/lib/durable-objects/tenant-library/tenant-library.ts#L142-L187
[emdash]: https://github.com/emdash-cms/emdash/tree/30604dcb0538df477ea0d8bde894ecdb57388bad
[em-runner]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/cloudflare/src/sandbox/runner.ts#L349-L405
[em-name]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/cloudflare/src/sandbox/runner.ts#L329-L330
[em-bridge]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/cloudflare/src/sandbox/bridge.ts#L935-L950
[em-renderer]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/blocks/src/renderer.tsx#L21-L125
[em-native]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/astro/integration/index.ts#L552-L585
[cfos]: https://github.com/cloudflare/cloudflare-os/tree/8060cd9fde6bdec1159df46054f0a559e93822a1
[os-loader]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-backend/src/overseer.ts#L4447-L4510
[os-env]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-backend/src/overseer.ts#L2525-L2537
[os-facet]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-backend/src/overseer.ts#L4581-L4588
[os-csp]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-frontend/src/GadgetUI.tsx#L105-L116
[os-iframe]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-frontend/src/GadgetUI.tsx#L507-L518
[os-handshake]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-frontend/src/GadgetUI.tsx#L340-L352
[os-shell]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-frontend/index.html#L7-L8
[os-webrtc]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-backend/src/browser-export.ts#L37-L39
[os-readme]: https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/README.md
