import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../src/host/library";
import { api, install, item, library, settle, tenant, upload } from "./helpers";

const search = (t: string, q: string) => api<SearchHit[]>(t, `/api/search?q=${encodeURIComponent(q)}`);

describe("challenge: a Parquet file under the settled contract", () => {
  it("reads only what it needs through byte ranges and indexes only what the plugin chose", async () => {
    let t = tenant();
    await install(t, "parquet@1.0.0");
    let bytes = Uint8Array.from(atob(env.PARQUET_FIXTURE), (c) => c.charCodeAt(0));
    let { itemId } = await settle(() => upload(t, bytes, "application/octet-stream", "bridge-sensors.parquet"));

    let view = await item(t, itemId);
    expect(view.card).toMatchObject({ title: "bridge-sensors.parquet", subtitle: "120,000 rows · 4 columns" });
    if (view.detail?.template !== "custom" || view.detail.fallback.template !== "record") throw new Error("expected a custom view with a record fallback");
    expect(view.detail.fallback.lists[0].items).toEqual([
      "ts (TIMESTAMP): 2026-09-01T00:00:00.000Z to 2026-09-21T19:59:45.000Z",
      "sensor (UTF8): deck-midspan to south-anchorage · values: deck-midspan, north-anchorage, south-anchorage",
      "strain_microstrain (DOUBLE): 80 to 169.99",
      "temperature_c (DOUBLE): 4 to 21.98",
    ]);

    let [run] = await library(t).runsFor(itemId);
    console.log(`bytes read: ${run.bytesRead} of ${bytes.byteLength} (${((100 * run.bytesRead) / bytes.byteLength).toFixed(1)}%)`);
    expect(run.bytesRead).toBeLessThan(bytes.byteLength / 3);

    expect((await search(t, "midspan")).length).toBe(1); // a distinct value of a small string column
    expect((await search(t, "temperature")).length).toBe(2); // column name, in the schema and its own segment
    expect(await search(t, "168.44")).toEqual([]); // a row value: never indexed
  });
});
