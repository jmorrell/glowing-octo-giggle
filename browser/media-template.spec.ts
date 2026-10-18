import { expect, test } from "@playwright/test";
import { install, settled, upload } from "./helpers";

test("transcript cues seek the player, and a highlight stays on its time range after re-transcription", async ({ page, request }) => {
  await install(request, "video@1.0.0");
  let itemId = await upload(request, "fixtures/inspection.webm", "video/webm");
  await page.goto(`/items/${itemId}`);
  let cues = page.locator("#cues li");
  await expect(cues).toHaveText([
    "Welcome to the bridge inspection walkthrough.",
    "The north cable anchorage shows surface rust.",
    "We recommend repainting before winter, before the first frost.",
  ]);
  await expect(page.locator(".thumbs img")).toHaveCount(3);

  await cues.nth(2).click();
  await expect.poll(() => page.evaluate(() => document.querySelector("video")!.currentTime)).toBe(9);
  await expect(cues.nth(2)).toHaveClass(/active/);

  // Select part of the second cue, as a reader would, and highlight it.
  await page.evaluate(() => {
    let text = document.querySelectorAll("#cues li")[1].firstChild!;
    let range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 44);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole("button", { name: "Highlight selection" }).click();
  await expect(page.locator("#annotations li")).toHaveText(["“north cable anchorage shows surface rust”exact"]);
  await expect(cues.nth(1)).toHaveClass(/annotated/);

  await install(request, "video@2.0.0");
  await request.post(`/api/items/${itemId}/reprocess`, { data: { processors: ["transcript"] } });
  await settled(request, itemId);
  await page.reload();
  await expect(cues).toHaveCount(4);
  await expect(page.locator("#annotations li")).toHaveText(["“north cable anchorage shows surface rust”text-changed"]);
  // The highlight covers 4-9 s, which the new model split into two cues.
  await expect(cues.nth(1)).toHaveClass(/annotated/);
  await expect(cues.nth(2)).toHaveClass(/annotated/);
  await expect(cues.nth(0)).not.toHaveClass(/annotated/);
});
