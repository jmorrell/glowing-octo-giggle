import { describe, expect, it } from "vitest";
import { install, item, settle, tenant, upload, webm } from "./helpers";

describe("smoke", () => {
  it("processes an uploaded video through the isolate and commits each output", async () => {
    let t = tenant();
    await install(t, "video@1.0.0");
    let { itemId, plugin } = await settle(() => upload(t, webm(), "video/webm", "bridge-inspection.webm"));
    expect(plugin).toBe("example.video");
    let view = await item(t, itemId);
    console.log(JSON.stringify({ card: view.card, detail: view.detail, statuses: view.statuses }, null, 1));
    expect(view.statuses.map((status) => status.state)).toEqual(["committed", "committed", "committed"]);
  });
});
