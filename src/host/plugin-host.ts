import { WorkerEntrypoint } from "cloudflare:workers";
import type { ArtifactAddress, ByteRange, HostCapabilities, ServiceName, TranscriptCue } from "../contract";
import type { RunContext } from "./library";

export const MAX_READ_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

async function digest(data: Uint8Array | string): Promise<string> {
  let bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The only authority a processor receives. `props` are set by the host when it creates the
 * stub for one run; every method re-derives item, original, and grants from the run record.
 */
export class PluginHost extends WorkerEntrypoint<Env, { tenant: string; runId: string }> implements HostCapabilities {
  private get library() {
    return this.env.LIBRARY.getByName(this.ctx.props.tenant);
  }

  private async run(service?: ServiceName): Promise<RunContext> {
    let run = await this.library.runContext(this.ctx.props.runId);
    if (service && !run.services.includes(service)) throw new Error(`Service ${service} was not granted to this plugin`);
    return run;
  }

  async readOriginal(range?: ByteRange): Promise<Uint8Array> {
    let { original } = await this.run();
    let offset = range?.offset ?? 0;
    let length = range?.length ?? original.byteLength - offset;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error("Invalid range");
    if (length > MAX_READ_BYTES) throw new Error(`Read at most ${MAX_READ_BYTES} bytes per call`);
    length = Math.min(length, Math.max(0, original.byteLength - offset));
    if (length === 0) return new Uint8Array();
    let object = await this.env.BLOBS.get(original.key, { range: { offset, length } });
    if (!object) throw new Error("Original is missing");
    let bytes = new Uint8Array(await object.arrayBuffer());
    await this.library.recordRead(this.ctx.props.runId, bytes.byteLength);
    return bytes;
  }

  async putArtifact(name: string, body: Uint8Array | string, mediaType: string): Promise<ArtifactAddress> {
    let bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`Artifacts are limited to ${MAX_ARTIFACT_BYTES} bytes`);
    let { key, processor } = await this.library.stageArtifact(this.ctx.props.runId, name, mediaType, bytes.byteLength);
    // Stands in for a transient storage failure after paid work; armed only by tests.
    if (await this.library.consumeFault(`put:${processor}`)) throw new Error("Injected storage failure");
    await this.env.BLOBS.put(key, bytes, { httpMetadata: { contentType: mediaType } });
    return { processor, name };
  }

  // Paid services are memoized in the tenant's Library before returning to the plugin, so a
  // retried run (or another processor of the same item) does not pay again for the same input.
  private async memoized<T>(key: string, compute: () => Promise<T>): Promise<T> {
    let cached = await this.library.memoGet(key);
    if (cached !== null) return JSON.parse(cached);
    let value = await compute();
    await this.library.memoPut(key, JSON.stringify(value));
    return value;
  }

  async transcribe({ model }: { model: string }): Promise<TranscriptCue[]> {
    let { original } = await this.run("transcribe");
    return this.memoized(`transcribe:${original.sha256}:${model}`, () => this.env.VENDOR.getByName("vendor").transcribe(original.sha256, model));
  }

  async extractFrames({ at }: { at: number[] }): Promise<{ at: number; image: Uint8Array; mediaType: string }[]> {
    let { original } = await this.run("extract-frames");
    if (!Array.isArray(at) || at.length > 100 || !at.every((t) => Number.isFinite(t) && t >= 0)) throw new Error("Request 1-100 timestamps");
    let frames = [];
    for (let t of at) {
      let { base64, mediaType } = await this.memoized(`frame:${original.sha256}:${t}`, () => this.env.VENDOR.getByName("vendor").frame(original.sha256, t));
      frames.push({ at: t, image: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), mediaType });
    }
    return frames;
  }

  async describeImage({ image, mediaType }: { image: Uint8Array; mediaType: string }): Promise<{ text: string; model: string }> {
    await this.run("describe-image");
    if (!(image instanceof Uint8Array) || image.byteLength > 5 * 1024 * 1024 || !mediaType.startsWith("image/")) throw new Error("Expected an image up to 5 MiB");
    return this.memoized(`describe:${await digest(image)}`, () => this.env.VENDOR.getByName("vendor").describe(image));
  }
}
