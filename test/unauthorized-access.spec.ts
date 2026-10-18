import { describe, expect, it } from "vitest";
import { install, item, library, rejection, settle, tenant, upload } from "./helpers";

const text = (value: string) => new TextEncoder().encode(value);

async function probe(t: string, secret: string) {
  let { itemId } = await settle(() => upload(t, text(secret), "text/plain", "note.txt"));
  let view = await item(t, itemId);
  if (view.detail?.template !== "record") throw new Error(`expected probe results, got ${JSON.stringify(view.statuses)}`);
  return Object.fromEntries(view.detail.fields.map((field) => [field.label, field.value]));
}

describe("a processor cannot exceed the authority of its run", () => {
  it("has no network, bindings, ungranted services, unsafe artifacts, or host internals", async () => {
    let t = tenant();
    await install(t, "hostile@1.0.0");
    let results = await probe(t, "first item secret ......");
    expect(results).toMatchObject({
      "global fetch": expect.stringMatching(/^denied: This worker is not permitted to access the internet/),
      "socket connect": expect.stringMatching(/^denied: This worker is not permitted to access the internet/),
      "env bindings": "allowed: []",
      "ungranted service": expect.stringMatching(/^denied: .*Service transcribe was not granted/),
      "oversized read": expect.stringMatching(/^denied: .*Read at most/),
      "active content artifact": expect.stringMatching(/^denied: .*text\/html cannot be stored/),
      "path traversal artifact": expect.stringMatching(/^denied: .*Invalid artifact name/),
      "host internals": expect.stringMatching(/^denied: .*does not implement the method "env"/),
      "own original": "first item secret ......",
    });
  });

  it("cannot reuse one run's capability in a later run, even in the same isolate", async () => {
    let t = tenant();
    await install(t, "hostile@1.0.0");
    await probe(t, "first item secret ......");
    let second = await probe(t, "second item secret .....");
    expect(second["previous run's capability"]).toMatch(/^denied: Cannot perform I\/O on behalf of a different request/);
    expect(second["own original"]).toBe("second item secret .....");
  });

  it("gives each tenant's run only that tenant's original when both install the same release", async () => {
    let a = tenant();
    let b = tenant();
    await install(a, "hostile@1.0.0");
    await install(b, "hostile@1.0.0");
    let first = await probe(a, "tenant A private bytes..");
    let second = await probe(b, "tenant B private bytes..");
    expect(first["own original"]).toBe("tenant A private bytes..");
    expect(second["own original"]).toBe("tenant B private bytes..");
    expect(second["previous run's capability"]).toBeUndefined(); // separate isolates per tenant
  });

  it("rejects results that reference undeclared processors or another plugin's selectors", async () => {
    let t = tenant();
    await install(t, "hostile-bad-result@1.0.0");
    let { itemId } = await settle(() => upload(t, text("anything"), "text/plain", "note.txt"));
    let [run] = await library(t).runsFor(itemId);
    expect(run.state).toBe("rejected");
    expect(run.reason).toContain("unknown processor undeclared");
    expect(run.reason).toContain("plugin selectors must name their own plugin");
    let view = await item(t, itemId);
    expect(view.detail).toBeNull();
    expect(view.card.title).toBe("note.txt");
  });

  it("revokes an in-flight run's authority when the plugin is removed or upgraded", async () => {
    let t = tenant();
    await install(t, "video@1.0.0");
    let { itemId } = await settle(() => upload(t, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]), "video/webm", "clip.webm"));
    let [upgradeRun] = await library(t).startRuns(itemId, ["transcript"]);
    await install(t, "video@2.0.0");
    expect(await rejection(() => library(t).runContext(upgradeRun.id))).toMatch(/plugin release changed/);
    expect(await library(t).commitRun(upgradeRun.id, { search: [] })).toEqual({ committed: false, reason: "plugin release changed" });

    let [removalRun] = await library(t).startRuns(itemId, ["transcript"]);
    await library(t).uninstall("example.video");
    expect(await rejection(() => library(t).runContext(removalRun.id))).toMatch(/plugin removed/);
    expect(await library(t).commitRun(removalRun.id, { search: [] })).toEqual({ committed: false, reason: "plugin removed" });
  });
});
