// Runs real Stacks handler, sanitizer, and FTS schema code against synthetic inputs.
// Usage: node evidence/stacks/run.mjs <path to a Stacks checkout's app/ directory with node_modules>
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let app = resolve(process.argv[2] ?? "");
let src = join(app, "src/server/lib/content-fetch");
let out = mkdtempSync(join(process.env.EVIDENCE_TMP ?? tmpdir(), "stacks-evidence-"));
let stub = join(out, "stub.mjs");
writeFileSync(stub, "export let tracing = { getActiveSpan() {}, startSpan() { return { setAttributes() {}, end() {} }; } }; export default {};");
writeFileSync(join(out, "entry.ts"), `
  export { default as YoutubeHandler } from ${JSON.stringify(join(src, "content-handlers/websites/youtube-handler.ts"))};
  export { default as HtmlHandler } from ${JSON.stringify(join(src, "content-handlers/html-handler.ts"))};
  export { default as sanitizeHtml } from "sanitize-html";
`);
await build({
  entryPoints: [join(out, "entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(out, "bundle.mjs"),
  nodePaths: [join(app, "node_modules")],
  alias: { "cloudflare:workers": stub, "@cloudflare/puppeteer": stub },
  loader: { ".txt": "text" },
  logLevel: "error",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
let { YoutubeHandler, HtmlHandler, sanitizeHtml } = await import(pathToFileURL(join(out, "bundle.mjs")).href);

// 1. YouTube handler output through the reader's sanitizer options
//    (copied from app/src/svelte/src/routes/library/[id]/+page.server.ts lines 32-59).
globalThis.fetch = async () =>
  Response.json({ title: "Synthetic video", width: 560, height: 315, author_name: "Author", author_url: "https://www.youtube.com/@author" });
let video = await new YoutubeHandler().handle({}, "https://www.youtube.com/watch?v=Synthetic123", "item", "text/html");
let resolveUrl = (value, baseUrl) => (value ? (URL.parse(value, baseUrl)?.href ?? "") : "");
let sanitized = sanitizeHtml(video.content.readableContent, {
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    span: ["class", "style"],
    img: ["data-ai-description", "data-ai-description-model", "alt", "decoding", "height", "loading", "src", "srcset", "sizes", "style", "title", "width"],
  },
  allowedClasses: { span: ["image-preview"] },
  allowedStyles: { img: { "background-color": [/^#[0-9a-f]{6}$/i] }, span: { "background-color": [/^#[0-9a-f]{6}$/i], "--image-preview": [/^url\(["']?data:image\/webp;base64,[a-z0-9+/=]+["']?\)$/i] } },
  allowedTags: sanitizeHtml.defaults.allowedTags.concat("img"),
  transformTags: {
    a: (tagName, attributes) => ({ tagName, attribs: { ...attributes, href: resolveUrl(attributes.href, video.metadata.url) } }),
    img: (tagName, attributes) => ({ tagName, attribs: { ...attributes, src: resolveUrl(attributes.src, video.metadata.url) } }),
  },
});
console.log(JSON.stringify({
  experiment: "youtube-readable-through-reader-sanitizer",
  storedReadableHasIframe: video.content.readableContent.includes("<iframe"),
  renderedHasIframe: sanitized.includes("<iframe"),
  renderedText: sanitized.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
}));

// 2. What the generated TenantLibrary FTS schema indexes for an HTML capture.
let snapshot = `<!doctype html><html><head><title>Bridge notes</title></head><body><article>
  <h1>Bridge notes</h1><p>The suspension cables were inspected in spring.</p>
  <p>See the <a href="https://example.org/report">inspection report</a>.</p>
  <img src="https://example.org/cable.jpg" alt="Cable anchorage"></article></body></html>`;
let page = await new HtmlHandler().handle({}, "https://example.org/bridge", "item", "text/html", snapshot);
let db = new DatabaseSync(":memory:");
let schema = readFileSync(join(app, "src/server/lib/durable-objects/tenant-library/tenant-library.sql"), "utf8");
// The generated snapshot lists triggers before tables; FTS5 creates its own shadow tables.
let statements = schema.replace(/^--.*$/gm, "").split(/;\s*\n\s*\n/).map((s) => s.trim()).filter((s) => s && !/CREATE TABLE 'library_search_fts_/.test(s));
let order = (s) => (s.startsWith("CREATE TRIGGER") ? 2 : s.startsWith("CREATE VIRTUAL") || s.includes("INDEX") ? 1 : 0);
for (let statement of statements.sort((a, b) => order(a) - order(b))) db.exec(statement.endsWith(";") ? statement : statement + ";");
db.exec("INSERT INTO library_item (id, url) VALUES ('item', 'https://example.org/bridge')");
db.exec("INSERT INTO library_item_capture (id, library_item_id, state) VALUES ('capture', 'item', 'success')");
db.prepare(`INSERT INTO library_item_capture_details (slug, capture_id, handler_name, url, title, site_name, type, text_content)
  VALUES ('bridge', 'capture', ?, ?, ?, ?, 'html', ?)`).run(page.metadata.handlerName, page.metadata.url, page.metadata.title, page.metadata.siteName, page.metadata.textContent);
let match = (query) => db.prepare("SELECT count(*) AS n FROM library_search_fts WHERE library_search_fts MATCH ?").get(query).n;
let snippetRow = db.prepare("SELECT snippet(library_search_fts, 1, '<mark>', '</mark>', '...', 12) AS s FROM library_search_fts WHERE library_search_fts MATCH ?").get("href");
console.log(JSON.stringify({
  experiment: "fts-indexes-readable-markup",
  textContentStartsWith: page.metadata.textContent.slice(0, 60),
  matches: { cables: match("cables"), href: match("href"), src: match("src"), https: match("https") },
  contentSnippetForHref: snippetRow?.s,
}));
