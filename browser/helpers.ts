import { expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { releases } from "../src/generated/releases";

export async function install(request: APIRequestContext, key: keyof typeof releases) {
  let response = await request.post("/api/plugins", { data: releases[key] });
  expect(response.ok()).toBe(true);
}

/** Uploads a fixture and waits until no processor is still running. */
export async function upload(request: APIRequestContext, file: string, mediaType: string): Promise<string> {
  let response = await request.post("/api/items", { data: readFileSync(file), headers: { "Content-Type": mediaType, "X-Filename": file.split("/").pop()! } });
  expect(response.status()).toBe(201);
  let { itemId } = await response.json();
  await settled(request, itemId);
  return itemId;
}

export async function settled(request: APIRequestContext, itemId: string) {
  await expect
    .poll(async () => (await (await request.get(`/api/items/${itemId}`)).json()).statuses.every((s: { state: string }) => s.state !== "running" && s.state !== "pending"), { timeout: 20_000 })
    .toBe(true);
}
