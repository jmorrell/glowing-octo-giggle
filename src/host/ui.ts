// Host-rendered pages. Templates are host code; plugin data only ever reaches the DOM as
// text or as host-resolved artifact URLs. A custom component runs in an opaque-origin iframe.

const HOST_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "media-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

// Applied inside the component frame, in addition to the policy it inherits from the host
// page (srcdoc documents inherit their parent's policy container).
export const COMPONENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; " +
  "connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 980px; padding: 16px; color: #1d2733; }
  a { color: #0b5cad; } h1 { font-size: 1.5rem; margin: 0 0 4px; } .muted { color: #5b6773; }
  .cards { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .cards li { border: 1px solid #d5dde5; border-radius: 8px; padding: 12px; }
  .cards img { width: 100%; height: 80px; object-fit: cover; image-rendering: pixelated; border-radius: 4px; }
  .badge { font-size: 12px; background: #e8eef5; border-radius: 10px; padding: 1px 8px; margin-right: 4px; }
  .layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr); gap: 16px; }
  @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
  video { width: 100%; background: #000; }
  ol.cues { padding-left: 0; list-style: none; } .cues li { padding: 4px 6px; border-radius: 4px; cursor: pointer; }
  .cues li.active { background: #fff3c4; } .cues li.annotated { box-shadow: inset 3px 0 #d60; }
  .thumbs { display: flex; gap: 6px; } .thumbs img { width: 64px; height: 36px; image-rendering: pixelated; cursor: pointer; }
  iframe.component { width: 100%; height: 220px; border: 1px solid #d5dde5; border-radius: 8px; }
  #annotations li { margin-bottom: 8px; } #annotations .state { font-size: 12px; }
  dialog { border: 1px solid #b8c4cf; border-radius: 8px; max-width: 420px; } textarea { width: 100%; min-height: 80px; }`;

function page(title: string, body: string, csp: string | null): Response {
  let headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (csp) headers.set("Content-Security-Policy", csp);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`, { headers });
}

export function listPage(): Response {
  return page(
    "Library",
    `<h1>Library</h1>
    <form id="search"><input name="q" type="search" aria-label="Search" placeholder="Search"> <button>Search</button></form>
    <ul id="results"></ul><ul class="cards" id="cards"></ul>
    <script type="module">
      let el = (tag, { dataset = {}, ...props } = {}, ...children) => { let node = Object.assign(document.createElement(tag), props); Object.assign(node.dataset, dataset); node.append(...children); return node; };
      let cards = await (await fetch("/api/items")).json();
      document.getElementById("cards").append(...cards.map((card) => el("li", {},
        card.image ? el("img", { src: card.image, alt: "" }) : "",
        el("a", { href: "/items/" + card.id, textContent: card.title }),
        el("div", { className: "muted", textContent: (card.subtitle ?? "") + (card.processing ? " · processing" : "") }),
        el("div", {}, ...card.badges.map((badge) => el("span", { className: "badge", textContent: badge }))))));
      document.getElementById("search").addEventListener("submit", async (event) => {
        event.preventDefault();
        let q = new FormData(event.target).get("q");
        let hits = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
        let link = (hit) => "/items/" + hit.itemId + (hit.target?.type === "time" ? "#t=" + hit.target.start + "," + hit.target.end : hit.target?.type === "plugin" ? "#focus=" + encodeURIComponent(JSON.stringify(hit.target)) : "");
        document.getElementById("results").replaceChildren(...hits.map((hit) => el("li", {}, el("a", { href: link(hit), textContent: hit.title }), " ", el("span", { className: "muted", textContent: hit.snippet }))));
      });
    </script>`,
    HOST_CSP,
  );
}

export function itemPage(itemId: string, weakContainment: boolean): Response {
  // `weakContainment` omits the host page CSP so experiments can show which protections it supplies.
  return page(
    "Item",
    `<p><a href="/">← Library</a></p>
    <h1 id="title"></h1><p class="muted" id="subtitle"></p>
    <div class="layout"><main id="detail"></main><aside><h2>Notes</h2><ul id="annotations"></ul><h2>Processing</h2><ul id="statuses" class="muted"></ul></aside></div>
    <dialog id="composer"><form method="dialog"><p>Note on <strong id="composer-label"></strong></p>
      <textarea id="composer-note" aria-label="Note"></textarea>
      <p><button value="save" id="composer-save">Save note</button> <button value="cancel">Cancel</button></p></form></dialog>
    <script type="module">
      const ITEM = ${JSON.stringify(itemId)};
      const COMPONENT_CSP = ${JSON.stringify(COMPONENT_CSP)};
      let el = (tag, { dataset = {}, ...props } = {}, ...children) => { let node = Object.assign(document.createElement(tag), props); Object.assign(node.dataset, dataset); node.append(...children); return node; };
      let item;
      let component = null; // { port, pluginId }
      let load = async () => { item = await (await fetch("/api/items/" + ITEM)).json(); };
      // Addresses inside host-standard files (thumbnails.json) are plugin data: check them.
      let addressUrl = (address) => {
        let output = item.statuses.find((status) => status.processor === address?.processor)?.output;
        return output && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(address.name) ? "/api/items/" + ITEM + "/artifacts/" + output.runId + "/" + address.name : null;
      };
      let saveAnnotation = async (selectors, note) => {
        let response = await fetch("/api/items/" + ITEM + "/annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectors, note }) });
        if (!response.ok) throw new Error(await response.text());
        await load();
        renderChrome();
        renderAnnotationMarks();
      };

      function describe(annotation) {
        let selector = annotation.selectors.find((s) => s.type === "plugin") ?? annotation.selectors.find((s) => s.type === "text-quote") ?? annotation.selectors[0];
        if (selector.type === "plugin") return selector.label;
        if (selector.type === "text-quote") return "“" + selector.exact + "”";
        return selector.start + "–" + selector.end + " s";
      }
      function renderChrome() {
        document.getElementById("title").textContent = item.card.title;
        document.getElementById("subtitle").textContent = [item.card.subtitle, item.plugin && (item.plugin.id + (item.plugin.installed ? "" : " (removed)"))].filter(Boolean).join(" · ");
        document.getElementById("annotations").replaceChildren(...item.annotations.map((a) =>
          el("li", { dataset: { state: a.state, id: a.id } }, el("div", { textContent: describe(a) }), el("div", { textContent: a.note ?? "" }), el("div", { className: "state muted", textContent: a.state }))));
        document.getElementById("statuses").replaceChildren(...item.statuses.map((s) => el("li", { textContent: s.processor + ": " + s.state + (s.output ? " (showing " + s.output.pluginVersion + ")" : "") })));
      }
      let renderAnnotationMarks = () => {};

      function renderRecord(view, container) {
        container.replaceChildren(
          el("dl", {}, ...view.fields.flatMap((field) => [el("dt", { textContent: field.label }), el("dd", { textContent: field.value })])),
          ...view.lists.flatMap((list) => [el("h3", { textContent: list.label }), el("ul", {}, ...list.items.map((entry) => el("li", { textContent: entry })))]));
      }

      async function renderMedia(view, container) {
        let video = el("video", { id: "player", controls: true, preload: "metadata", src: view.media ?? "" });
        let cues = view.cues ? (await (await fetch(view.cues)).json()).cues : [];
        let thumbs = view.thumbnails ? (await (await fetch(view.thumbnails)).json()).frames : [];
        let list = el("ol", { className: "cues", id: "cues" }, ...cues.map((cue) => el("li", { textContent: cue.text, dataset: { start: cue.start, end: cue.end } })));
        let highlight = el("button", { id: "highlight", textContent: "Highlight selection" });
        container.replaceChildren(video,
          el("div", { className: "thumbs" }, ...thumbs.map((frame) => { let url = addressUrl(frame.image); return url ? el("img", { src: url, alt: "Frame at " + frame.at + " s", dataset: { at: frame.at } }) : ""; })),
          view.cues ? highlight : el("p", { className: "muted", textContent: "Transcript not available yet." }), list);
        let seek = (t) => { video.currentTime = Number(t); };
        list.addEventListener("click", (event) => { let li = event.target.closest("li"); if (li && getSelection().isCollapsed) seek(li.dataset.start); });
        container.querySelector(".thumbs").addEventListener("click", (event) => { if (event.target.dataset.at) seek(event.target.dataset.at); });
        video.addEventListener("timeupdate", () => {
          for (let li of list.children) li.classList.toggle("active", video.currentTime >= Number(li.dataset.start) && video.currentTime < Number(li.dataset.end));
        });
        highlight.addEventListener("click", async () => {
          let selection = getSelection();
          let first = selection.anchorNode?.parentElement?.closest("#cues li");
          let last = selection.focusNode?.parentElement?.closest("#cues li");
          let exact = selection.toString().trim();
          if (!first || !last || !exact) return;
          let [a, b] = [first, last].sort((x, y) => Number(x.dataset.start) - Number(y.dataset.start));
          await saveAnnotation([
            { type: "time", start: Number(a.dataset.start), end: Number(b.dataset.end) },
            { type: "text-quote", in: view.cuesAddress, exact },
          ], null);
        });
        renderAnnotationMarks = () => {
          for (let li of list.children) li.classList.toggle("annotated", item.annotations.some((a) => a.time && a.time.end > Number(li.dataset.start) && a.time.start < Number(li.dataset.end)));
        };
        renderAnnotationMarks();
        let match = location.hash.match(/^#t=([\\d.]+)/);
        if (match) seek(match[1]);
      }

      // The component's only channel is one MessagePort. Every call is checked here, against
      // this item and this plugin; nothing in a message can widen what the frame may do.
      function hostComponent(view, container, source) {
        let pluginId = item.plugin.id;
        let frame = el("iframe", { className: "component", title: "Plugin view" });
        frame.setAttribute("sandbox", "allow-scripts");
        let bootstrap = \`
          // Events that arrive before the component subscribes (such as a deep-link focus)
          // are held for its first listener rather than dropped.
          const pending = new Map(); let next = 1; const listeners = []; const held = [];
          const { port1, port2 } = new MessageChannel();
          parent.postMessage("magpie-handshake", "*", [port2]);
          port1.onmessage = ({ data }) => {
            if (data.type === "response") { let p = pending.get(data.id); pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); }
            if (data.type === "event") listeners.length ? listeners.forEach((listener) => listener(data.event)) : held.push(data.event);
          };
          const call = (method, params) => new Promise((resolve, reject) => { let id = next++; pending.set(id, { resolve, reject }); port1.postMessage({ type: "call", id, method, params }); });
          globalThis.magpie = Object.freeze({
            getData: () => call("getData"), read: (ref, range) => call("read", { ref, range }),
            getAnnotations: () => call("getAnnotations"), proposeAnnotation: (selector) => call("proposeAnnotation", { selector }),
            onEvent: (listener) => { listeners.push(listener); held.splice(0).forEach(listener); },
          });\`;
        // Neither this page's script nor the frame's may contain a literal closing script tag.
        let escape = (code) => code.replaceAll("<" + "/script", "<\\\\/script");
        frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + COMPONENT_CSP + '"><body><script type="module">' + escape(bootstrap + "\\n" + source) + "<\\/script></body>";
        let pluginAnnotations = () => item.annotations
          .map((a) => ({ id: a.id, selector: a.selectors.find((s) => s.type === "plugin" && s.plugin === pluginId) }))
          .filter((a) => a.selector);
        let handlers = {
          getData: async () => (view.data ? (await fetch(view.data)).json() : null),
          getAnnotations: async () => pluginAnnotations(),
          read: async ({ ref, range }) => {
            let url = ref === "original" ? item.revision.url : addressUrl(ref);
            if (!url || !Number.isSafeInteger(range?.offset) || !Number.isSafeInteger(range?.length) || range.length <= 0 || range.length > 1048576) throw new Error("Read refused");
            let response = await fetch(url, { headers: { Range: "bytes=" + range.offset + "-" + (range.offset + range.length - 1) } });
            return new Uint8Array(await response.arrayBuffer());
          },
          proposeAnnotation: async ({ selector }) => {
            if (selector?.type !== "plugin" || selector.plugin !== pluginId || typeof selector.value !== "string" || selector.value.length > 500 || typeof selector.label !== "string" || selector.label.length > 200) throw new Error("Selector refused");
            let dialog = document.getElementById("composer");
            document.getElementById("composer-label").textContent = selector.label;
            document.getElementById("composer-note").value = "";
            dialog.showModal();
            dialog.onclose = async () => {
              if (dialog.returnValue !== "save") return;
              await saveAnnotation([{ type: "plugin", plugin: pluginId, value: selector.value, label: selector.label }], document.getElementById("composer-note").value);
            };
          },
        };
        window.addEventListener("message", (event) => {
          // Only the frame we created, still at its opaque origin, may open the channel.
          if (event.source !== frame.contentWindow || event.origin !== "null" || event.data !== "magpie-handshake" || !event.ports[0]) return;
          let port = event.ports[0];
          component = { port, pluginId };
          port.onmessage = async ({ data }) => {
            // Lets the containment experiment's probe component surface what it observed.
            if (data?.type === "report") { window.dispatchEvent(new CustomEvent("component-report", { detail: data.report })); return; }
            if (data?.type !== "call" || !Object.hasOwn(handlers, data.method)) return port.postMessage({ type: "response", id: data?.id, error: "Unknown method" });
            try { port.postMessage({ type: "response", id: data.id, result: await handlers[data.method](data.params ?? {}) }); }
            catch (error) { port.postMessage({ type: "response", id: data.id, error: String(error?.message ?? error) }); }
          };
          let focus = location.hash.match(/^#focus=(.+)$/);
          if (focus) port.postMessage({ type: "event", event: { type: "focus", selector: JSON.parse(decodeURIComponent(focus[1])) } });
        });
        renderAnnotationMarks = () => component?.port.postMessage({ type: "event", event: { type: "annotations", annotations: pluginAnnotations() } });
        container.replaceChildren(frame);
      }

      await load();
      renderChrome();
      let container = document.getElementById("detail");
      let detail = item.detail;
      if (!detail) container.replaceChildren(el("p", { className: "muted", textContent: "No view yet." }), el("a", { href: item.revision.url, textContent: "Download original" }));
      else if (detail.template === "media") await renderMedia(detail, container);
      else if (detail.template === "record") renderRecord(detail, container);
      else if (detail.template === "custom") {
        let response = await fetch(detail.componentUrl);
        if (!response.ok) { detail = detail.fallback; detail.template === "media" ? await renderMedia(detail, container) : renderRecord(detail, container); }
        else hostComponent(detail, container, await response.text());
      }
      document.body.dataset.ready = "true";
    </script>`,
    weakContainment ? null : HOST_CSP,
  );
}
