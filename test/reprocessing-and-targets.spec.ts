import { beforeEach, describe, expect, it } from "vitest";
import type { Selector } from "../src/contract";
import type { SearchHit } from "../src/host/library";
import { api, install, item, settle, tenant, upload, vendor, webm } from "./helpers";

const cues = { processor: "transcript", name: "cues.json" };
// Time targets of every hit, earliest first (ranking order is not under test).
const targets = async (t: string, q: string) =>
  (await api<SearchHit[]>(t, `/api/search?q=${encodeURIComponent(q)}`)).map((hit) => hit.target).sort((a, b) => (a?.type === "time" && b?.type === "time" ? a.start - b.start : 0));
const annotate = (t: string, itemId: string, selectors: Selector[], note: string) =>
  api<{ id: string }>(t, `/api/items/${itemId}/annotations`, { method: "POST", body: JSON.stringify({ selectors, note }) });

describe("re-transcription with existing annotations and search hits", () => {
  beforeEach(() => vendor().reset());

  it("keeps time anchors, reports changed text, and orphans quotes it cannot place", async () => {
    let t = tenant();
    await install(t, "video@1.0.0");
    let { itemId } = await settle(() => upload(t, webm(), "video/webm", "inspection.webm"));

    // Highlights made in the transcript carry the time range of their cues plus the quote.
    let rust = await annotate(t, itemId, [{ type: "time", start: 4, end: 9 }, { type: "text-quote", in: cues, exact: "north cable anchorage shows surface rust" }], "Check the rust");
    let welcome = await annotate(t, itemId, [{ type: "time", start: 0, end: 4 }, { type: "text-quote", in: cues, exact: "Welcome to the bridge" }], "Intro");
    let paint = await annotate(t, itemId, [{ type: "text-quote", in: cues, exact: "repainting", prefix: "We recommend", suffix: "before winter" }], "Budget");
    let ambiguous = await annotate(t, itemId, [{ type: "text-quote", in: cues, exact: "before" }], "Too vague to place");
    let states = async () => Object.fromEntries((await item(t, itemId)).annotations.map((a) => [a.id, { state: a.state, time: a.time }]));

    expect(await states()).toEqual({
      [rust.id]: { state: "exact", time: { start: 4, end: 9 } },
      [welcome.id]: { state: "exact", time: { start: 0, end: 4 } },
      [paint.id]: { state: "exact", time: { start: 9, end: 14 } },
      [ambiguous.id]: { state: "orphaned" },
    });
    expect(await targets(t, "repainting")).toEqual([{ type: "time", start: 9, end: 14 }]);
    // One hit from the transcript and one from the frame description ("cable anchorage with rust").
    expect(await targets(t, "rust")).toEqual([{ type: "time", start: 4, end: 9 }, { type: "time", start: 5, end: 10 }]);

    // A plugin upgrade switches to a model that segments and words the speech differently.
    await install(t, "video@2.0.0");
    await settle(() => api(t, `/api/items/${itemId}/reprocess`, { method: "POST", body: JSON.stringify({ processors: ["transcript"] }) }));

    expect(await states()).toEqual({
      [rust.id]: { state: "text-changed", time: { start: 4, end: 9 } }, // now "...shows light surface rust"
      [welcome.id]: { state: "exact", time: { start: 0, end: 4 } },
      [paint.id]: { state: "orphaned" }, // now "re-coating"; not moved to a guess
      [ambiguous.id]: { state: "orphaned" },
    });
    expect((await item(t, itemId)).annotations.map((a) => a.note)).toEqual(["Check the rust", "Intro", "Budget", "Too vague to place"]);

    // Hits come only from the current output and land on its time ranges.
    expect(await targets(t, "repainting")).toEqual([]);
    expect(await targets(t, "coating")).toEqual([{ type: "time", start: 9, end: 14 }]);
    expect(await targets(t, "rust")).toEqual([{ type: "time", start: 5, end: 10 }, { type: "time", start: 6.5, end: 9 }]);
    expect(await targets(t, "anchorage")).toEqual([{ type: "time", start: 3.5, end: 6.5 }, { type: "time", start: 5, end: 10 }]);
  });
});
