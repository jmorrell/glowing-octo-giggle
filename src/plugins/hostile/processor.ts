import { WorkerEntrypoint } from "cloudflare:workers";
import type { HostCapabilities, ProcessRequest, ProcessResult } from "../../contract";

// Test-only plugin. Each probe tries something a processor must not be able to do and
// records the outcome as a record field, which the test reads back through the host API.

type Probe = { label: string; value: string };
let stashed: HostCapabilities | undefined;

async function attempt(probes: Probe[], label: string, action: () => Promise<unknown>) {
  try {
    probes.push({ label, value: `allowed: ${String(await action()).slice(0, 200)}` });
  } catch (error) {
    probes.push({ label, value: `denied: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
  }
}

export default class HostileProcessor extends WorkerEntrypoint {
  async process(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult> {
    if (request.processor === "ui-probe") {
      // Supplies a custom view so the browser experiment can load the probe component.
      return { views: { card: { title: "ui probe" }, detail: { template: "custom", component: "probe", fallback: { template: "record", fields: [] } } } };
    }
    if (request.processor === "bad-result") {
      return {
        search: [{ text: "x", target: { type: "plugin", plugin: "example.video", value: "#1", label: "someone else's selector" } }],
        views: { card: { title: "x", image: { processor: "undeclared", name: "a.png" } }, detail: { template: "record", fields: [] } },
      };
    }
    let probes: Probe[] = [];
    await attempt(probes, "global fetch", async () => (await fetch("https://example.com/")).status);
    await attempt(probes, "socket connect", async () => {
      let { connect } = await import("cloudflare:sockets");
      await connect("example.com:80").opened;
      return "opened";
    });
    await attempt(probes, "env bindings", async () => JSON.stringify(Object.keys(this.env ?? {})));
    await attempt(probes, "ungranted service", () => host.transcribe({ model: "fast-1" }));
    await attempt(probes, "oversized read", () => host.readOriginal({ offset: 0, length: 9 * 1024 * 1024 }));
    await attempt(probes, "active content artifact", () => host.putArtifact("page.html", "<script>alert(1)</script>", "text/html"));
    await attempt(probes, "path traversal artifact", () => host.putArtifact("../escape", "x", "text/plain"));
    await attempt(probes, "host internals", async () => typeof (await (host as unknown as { env: Promise<unknown> }).env));
    if (stashed) {
      let previous = stashed;
      await attempt(probes, "previous run's capability", async () => new TextDecoder().decode(await previous.readOriginal({ offset: 0, length: 24 })));
    }
    stashed = host;
    probes.push({ label: "own original", value: new TextDecoder().decode(await host.readOriginal({ offset: 0, length: 24 })) });
    return { views: { card: { title: "probe" }, detail: { template: "record", fields: probes } } };
  }
}
