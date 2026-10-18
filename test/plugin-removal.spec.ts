import { SELF } from "cloudflare:test";
import step from "../fixtures/bracket-assembly.step?raw";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../src/host/library";
import { api, install, item, settle, tenant, upload, vendor, webm } from "./helpers";

const search = (t: string, q: string) => api<SearchHit[]>(t, `/api/search?q=${encodeURIComponent(q)}`);
const get = (t: string, path: string) => SELF.fetch(`https://magpie.test${path}`, { headers: { "X-Tenant": t } });

describe("removing a plugin", () => {
  it("leaves template views, artifacts, search, and annotations usable but stops processing", async () => {
    await vendor().reset();
    let t = tenant();
    await install(t, "video@1.0.0");
    let { itemId } = await settle(() => upload(t, webm(), "video/webm", "inspection.webm"));
    await api(t, `/api/items/${itemId}/annotations`, { method: "POST", body: JSON.stringify({ selectors: [{ type: "time", start: 4, end: 9 }], note: "Rust" }) });

    await api(t, "/api/plugins/example.video", { method: "DELETE" });
    let view = await item(t, itemId);
    expect(view.plugin).toEqual({ id: "example.video", installed: false });
    expect(view.card).toMatchObject({ title: "inspection", image: expect.stringContaining("/poster.bmp") });
    expect(view.detail).toMatchObject({ template: "media", media: expect.any(String), cues: expect.any(String), thumbnails: expect.any(String) });
    expect(view.annotations.map((a) => a.state)).toEqual(["exact"]);
    if (view.detail?.template !== "media") throw new Error("expected media view");
    let cues = await get(t, view.detail.cues!);
    expect(cues.status).toBe(200);
    expect((await cues.json<{ cues: unknown[] }>()).cues).toHaveLength(3);
    expect((await search(t, "anchorage")).length).toBe(2);
    await expect(api(t, `/api/items/${itemId}/reprocess`, { method: "POST", body: "{}" })).rejects.toThrow(/No installed plugin/);
  });

  it("falls back from a removed custom component and keeps its annotations by label", async () => {
    let t = tenant();
    await install(t, "cad@1.0.0");
    let { itemId, plugin } = await settle(() => upload(t, new TextEncoder().encode(step), "application/octet-stream", "bracket-assembly.step"));
    expect(plugin).toBe("example.cad");
    let view = await item(t, itemId);
    expect(view.detail).toMatchObject({ template: "custom", componentUrl: "/api/plugins/example.cad/components/viewer", data: expect.stringContaining("/parts.json") });
    let selector = { type: "plugin", plugin: "example.cad", value: "#10", label: "Mounting bracket (#10)" } as const;
    await api(t, `/api/items/${itemId}/annotations`, { method: "POST", body: JSON.stringify({ selectors: [selector], note: "Check weld" }) });
    expect((await search(t, "bracket"))[0]?.target).toEqual(selector);

    await api(t, "/api/plugins/example.cad", { method: "DELETE" });
    view = await item(t, itemId);
    expect(view.detail).toMatchObject({ template: "record", lists: [{ label: "Parts", items: expect.arrayContaining(["Mounting bracket (#10): L-shaped steel bracket, 3 mm"]) }] });
    expect(view.annotations).toMatchObject([{ state: "delegated", note: "Check weld", selectors: [selector] }]);
    expect((await get(t, "/api/plugins/example.cad/components/viewer")).status).toBe(404);
  });
});
