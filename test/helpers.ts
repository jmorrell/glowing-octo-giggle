import { env, introspectWorkflow, SELF } from "cloudflare:test";
import type { PluginRelease } from "../src/contract";
import type { ItemResponse } from "../src/host/library";
import { releases } from "../src/generated/releases";

export type ReleaseKey = keyof typeof releases;

export function tenant(): string {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}

export async function api<T>(tenantName: string, path: string, init: RequestInit = {}): Promise<T> {
  let response = await SELF.fetch(`https://magpie.test${path}`, { ...init, headers: { "X-Tenant": tenantName, ...init.headers } });
  let body = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${body}`);
  return JSON.parse(body);
}

export function install(tenantName: string, release: ReleaseKey | PluginRelease) {
  let body = typeof release === "string" ? releases[release] : release;
  return api<{ digest: string }>(tenantName, "/api/plugins", { method: "POST", body: JSON.stringify(body) });
}

export function upload(tenantName: string, bytes: Uint8Array, mediaType: string, filename: string) {
  return api<{ itemId: string; plugin: string | null; workflowId: string | null }>(tenantName, "/api/items", {
    method: "POST",
    body: bytes,
    headers: { "Content-Type": mediaType, "X-Filename": filename },
  });
}

export function item(tenantName: string, itemId: string) {
  return api<ItemResponse>(tenantName, `/api/items/${itemId}`);
}

/** WebM/EBML magic followed by filler: enough for the video plugin's container check. */
export function webm(fill = 1): Uint8Array {
  let bytes = new Uint8Array(4096).fill(fill);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
}

/** Runs `start` and waits for every Workflow instance it created, with retry delays removed. */
export async function settle<T>(start: () => Promise<T>): Promise<T> {
  await using workflows = await introspectWorkflow(env.PROCESS);
  await workflows.modifyAll(async (instance) => {
    await instance.disableRetryDelays();
  });
  let value = await start();
  for (let instance of await workflows.get()) await instance.waitForStatus("complete");
  return value;
}

export const vendor = () => env.VENDOR.getByName("vendor");
export const library = (tenantName: string) => env.LIBRARY.getByName(tenantName);

/** Error message from a rejected RPC call (asserting on RPC promises with `.rejects` leaks a rejection). */
export async function rejection(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to fail");
}
