import type { InputFacts, PluginRelease, Selector } from "../contract";
import { itemPage, listPage } from "./ui";

export { Library } from "./library";
export { PluginHost } from "./plugin-host";
export { ProcessWorkflow } from "./process-workflow";
export { Vendor } from "./vendor";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  let hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Plugin artifacts are served from the application's origin, so they must never render as
// an active document there, whatever their declared type.
const INERT_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};

async function serveObject(env: Env, request: Request, key: string, mediaType: string, cacheControl: string): Promise<Response> {
  let object = await env.BLOBS.get(key, { range: request.headers });
  if (!object) return new Response("Not found", { status: 404 });
  let headers = new Headers({ ...INERT_HEADERS, "Content-Type": mediaType, "Accept-Ranges": "bytes", "Cache-Control": cacheControl });
  let range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (request.headers.has("Range") && range) {
    let offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    let length = range.suffix ?? range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

function badRequest(error: unknown): Response {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let url = new URL(request.url);
    // Authentication is not modeled: the tenant comes from a header (or one local tenant).
    let tenant = request.headers.get("X-Tenant") ?? "local";
    let library = env.LIBRARY.getByName(tenant);
    let path = url.pathname.split("/").filter(Boolean);
    let route = `${request.method} /${path.map((part, index) => (index > 1 && path[0] === "api" ? ":" : part)).join("/")}`;

    try {
      if (request.method === "GET" && url.pathname === "/") return listPage();
      if (request.method === "GET" && path[0] === "items" && path.length === 2) return itemPage(path[1], url.searchParams.get("containment") === "weak");

      if (route === "POST /api/plugins") return Response.json(await library.install(await request.json<PluginRelease>()));
      if (route === "DELETE /api/plugins/:") {
        await library.uninstall(path[2]);
        return Response.json({ ok: true });
      }
      if (route === "GET /api/plugins/:/:/:" && path[3] === "components") {
        let module = await library.componentModule(path[2], path[4]);
        return module === null
          ? new Response("Component unavailable", { status: 404 })
          : new Response(module, { headers: { ...INERT_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      }

      if (route === "POST /api/items") {
        let body = await request.arrayBuffer();
        if (body.byteLength === 0 || body.byteLength > MAX_UPLOAD_BYTES) return badRequest("Upload 1 byte to 50 MiB");
        let mediaType = (request.headers.get("Content-Type") ?? "application/octet-stream").split(";")[0].trim();
        let filename = request.headers.get("X-Filename") ?? "upload";
        let sha256 = await sha256Hex(body);
        let key = `t/${tenant}/originals/${crypto.randomUUID()}`;
        await env.BLOBS.put(key, body, { httpMetadata: { contentType: mediaType } });
        let input: InputFacts = { kind: "upload", filename };
        return Response.json(await library.createItem(input, { key, sha256, mediaType, byteLength: body.byteLength }), { status: 201 });
      }
      if (route === "GET /api/items") return Response.json(await library.listItems());
      if (route === "GET /api/items/:") {
        let item = await library.getItem(path[2]);
        return item ? Response.json(item) : new Response("Not found", { status: 404 });
      }
      if (route === "DELETE /api/items/:") {
        await library.deleteItem(path[2]);
        return Response.json({ ok: true });
      }
      if (route === "POST /api/items/:/:" && path[3] === "reprocess") {
        let { processors } = await request.json<{ processors?: string[] }>();
        return Response.json(await library.reprocess(path[2], processors));
      }
      if (route === "POST /api/items/:/:" && path[3] === "annotations") {
        let { selectors, note } = await request.json<{ selectors: Selector[]; note?: string | null }>();
        return Response.json(await library.addAnnotation(path[2], selectors, note ?? null), { status: 201 });
      }
      if (route === "GET /api/items/:/:" && path[3] === "original") {
        let original = await library.servableOriginal(path[2]);
        return original ? serveObject(env, request, original.key, original.mediaType, "private, no-cache") : new Response("Not found", { status: 404 });
      }
      if (route === "GET /api/items/:/:/:/:" && path[3] === "artifacts") {
        let artifact = await library.servableArtifact(path[2], path[4], path[5]);
        // Run-scoped URLs never change content, so clients may cache them indefinitely.
        return artifact ? serveObject(env, request, artifact.key, artifact.mediaType, "private, max-age=31536000, immutable") : new Response("Not found", { status: 404 });
      }
      if (route === "GET /api/search") return Response.json(await library.search(url.searchParams.get("q") ?? ""));
    } catch (error) {
      return badRequest(error);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
