import { beforeEach, describe, expect, it } from "vitest";
import type { SearchHit } from "../src/host/library";
import { api, install, item, library, settle, tenant, upload, vendor, webm } from "./helpers";

const search = (t: string, q: string) => api<SearchHit[]>(t, `/api/search?q=${encodeURIComponent(q)}`);
const reprocess = (t: string, itemId: string, processors: string[]) =>
  settle(() => api(t, `/api/items/${itemId}/reprocess`, { method: "POST", body: JSON.stringify({ processors }) }));

describe("partial failure and retry", () => {
  beforeEach(() => vendor().reset());

  it("retries a failed processor without paying for transcription again", async () => {
    let t = tenant();
    await install(t, "video@1.0.0");
    // Storage fails once after the paid call returned, so the whole processor step retries.
    await library(t).setFault("put:transcript", 1);
    let { itemId } = await settle(() => upload(t, webm(), "video/webm", "clip.webm"));

    expect((await vendor().calls()).transcribe).toBe(1);
    expect(await library(t).consumeFault("put:transcript")).toBe(false); // the injected failure happened
    let transcriptRuns = (await library(t).runsFor(itemId)).filter((run) => run.processor === "transcript");
    expect(transcriptRuns.map((run) => run.state)).toEqual(["committed"]);
    expect((await item(t, itemId)).detail).toMatchObject({ template: "media", cues: expect.stringContaining("/cues.json") });
  });

  it("keeps committed outputs visible when another derivative fails", async () => {
    let t = tenant();
    await install(t, "video@1.0.0");
    await vendor().setOutage("describe", true);
    let { itemId } = await settle(() => upload(t, webm(), "video/webm", "clip.webm"));

    let view = await item(t, itemId);
    expect(Object.fromEntries(view.statuses.map((s) => [s.processor, s.state]))).toEqual({ media: "committed", transcript: "committed", frames: "failed" });
    expect(view.statuses.find((s) => s.processor === "frames")?.reason).toContain("describe is unavailable");
    expect(view.detail).toMatchObject({ template: "media", media: expect.any(String), cues: expect.any(String), thumbnails: null });
    expect(view.card).toMatchObject({ title: "clip", image: null });
    expect((await search(t, "anchorage")).length).toBe(1);
    expect(await search(t, "towers")).toEqual([]);
    // Three attempts: frames were extracted once and memoized; each attempt hit the outage.
    expect(await vendor().calls()).toMatchObject({ transcribe: 1, frame: 3, describe: 3 });

    await vendor().setOutage("describe", false);
    await reprocess(t, itemId, ["frames"]);
    view = await item(t, itemId);
    expect(view.statuses.find((s) => s.processor === "frames")?.state).toBe("committed");
    expect(view.card.image).toContain("/poster.bmp");
    expect((await search(t, "towers"))[0]?.target).toEqual({ type: "time", start: 0, end: 5 });
    expect(await vendor().calls()).toMatchObject({ transcribe: 1, frame: 3, describe: 6 });
  });

  it("serves the previous output while a replacement runs and after it fails", async () => {
    let t = tenant();
    await install(t, "video@1.0.0");
    let { itemId } = await settle(() => upload(t, webm(), "video/webm", "clip.webm"));
    let original = (await item(t, itemId)).statuses.find((s) => s.processor === "transcript")!.output!;
    await install(t, "video@2.0.0");

    let [pending] = await library(t).startRuns(itemId, ["transcript"]);
    let during = (await item(t, itemId)).statuses.find((s) => s.processor === "transcript")!;
    expect(during).toMatchObject({ state: "running", output: original });

    await vendor().setOutage("transcribe", true);
    await reprocess(t, itemId, ["transcript"]);
    let after = await item(t, itemId);
    expect(after.statuses.find((s) => s.processor === "transcript")).toMatchObject({ state: "failed", output: original });
    expect((await search(t, "repainting"))[0]?.target).toEqual({ type: "time", start: 9, end: 14 });
    // The manually started run was superseded by the reprocess and can no longer commit.
    expect(await library(t).commitRun(pending.id, { search: [] })).toEqual({ committed: false, reason: "superseded by a newer run" });

    await vendor().setOutage("transcribe", false);
    await reprocess(t, itemId, ["transcript"]);
    let replaced = (await item(t, itemId)).statuses.find((s) => s.processor === "transcript")!;
    expect(replaced).toMatchObject({ state: "committed", output: { pluginVersion: "2.0.0" } });
    expect(await search(t, "repainting")).toEqual([]);
  });
});
