import { DurableObject } from "cloudflare:workers";
import type { TranscriptCue } from "../contract";

// A controlled stand-in for paid external services (speech-to-text, frame extraction,
// vision). It counts calls so tests can observe repeated paid work. Nothing here is real.

export const TRANSCRIPTS: Record<string, TranscriptCue[]> = {
  "fast-1": [
    { start: 0, end: 4, text: "Welcome to the bridge inspection walkthrough." },
    { start: 4, end: 9, text: "The north cable anchorage shows surface rust." },
    { start: 9, end: 14, text: "We recommend repainting before winter, before the first frost." },
  ],
  // A later model segments differently and words some passages differently.
  "accurate-2": [
    { start: 0, end: 3.5, text: "Welcome to the bridge inspection walk-through." },
    { start: 3.5, end: 6.5, text: "The north cable anchorage" },
    { start: 6.5, end: 9, text: "shows light surface rust." },
    { start: 9, end: 14, text: "We recommend re-coating before winter, before the first frost." },
  ],
};

const SCENES = ["deck and towers", "cable anchorage with rust", "maintenance crew on the deck"];

// 4x4 24-bit BMP: small enough to inline, renderable by browsers, distinct per timestamp.
function bmp(red: number, green: number, blue: number): Uint8Array {
  let width = 4;
  let height = 4;
  let rowBytes = width * 3;
  let data = new Uint8Array(54 + rowBytes * height);
  let view = new DataView(data.buffer);
  data.set([0x42, 0x4d]);
  view.setUint32(2, data.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  for (let i = 54; i < data.length; i += 3) data.set([blue, green, red], i);
  return data;
}

export class Vendor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS calls (service TEXT PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outage (service TEXT PRIMARY KEY);`);
  }

  private charge(service: string) {
    this.ctx.storage.sql.exec("INSERT INTO calls (service, count) VALUES (?, 1) ON CONFLICT (service) DO UPDATE SET count = count + 1", service);
    if (this.ctx.storage.sql.exec("SELECT service FROM outage WHERE service = ?", service).toArray().length) {
      throw new Error(`${service} is unavailable`);
    }
  }

  async transcribe(_sha256: string, model: string): Promise<TranscriptCue[]> {
    this.charge("transcribe");
    let cues = TRANSCRIPTS[model];
    if (!cues) throw new Error(`Unknown model ${model}`);
    return cues;
  }

  async frame(_sha256: string, at: number): Promise<{ base64: string; mediaType: string }> {
    this.charge("frame");
    let shade = Math.min(255, Math.round(at * 18));
    return { base64: btoa(String.fromCharCode(...bmp(shade, 80, 255 - shade))), mediaType: "image/bmp" };
  }

  async describe(image: Uint8Array): Promise<{ text: string; model: string }> {
    this.charge("describe");
    // Byte 56 is the first pixel's red channel, which frame() derives from the timestamp.
    let scene = SCENES[Math.min(SCENES.length - 1, Math.floor(image[56] / 90))];
    return { text: `A frame showing the ${scene}.`, model: "fake-vision-1" };
  }

  async calls(): Promise<Record<string, number>> {
    let rows = this.ctx.storage.sql.exec<{ service: string; count: number }>("SELECT service, count FROM calls").toArray();
    return Object.fromEntries(rows.map((row) => [row.service, row.count]));
  }

  async setOutage(service: string, down: boolean): Promise<void> {
    if (down) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO outage (service) VALUES (?)", service);
    else this.ctx.storage.sql.exec("DELETE FROM outage WHERE service = ?", service);
  }

  async reset(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM calls; DELETE FROM outage;");
  }
}
