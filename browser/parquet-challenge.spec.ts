import { expect, test } from "@playwright/test";
import { install, upload } from "./helpers";

test("a sandboxed component queries a Parquet file through host range reads", async ({ page, request }) => {
  await install(request, "parquet@1.0.0");
  let itemId = await upload(request, "fixtures/bridge-sensors.parquet", "application/octet-stream");
  let requested = 0;
  page.on("request", (req) => {
    let range = req.headers()["range"]?.match(/^bytes=(\d+)-(\d+)$/);
    if (req.url().endsWith(`/api/items/${itemId}/original`) && range) requested += Number(range[2]) - Number(range[1]) + 1;
  });
  await page.goto(`/items/${itemId}`);
  // Expected value computed independently with the DuckDB CLI over the same rows.
  await expect(page.frameLocator("iframe.component").locator("#answer")).toHaveText("Peak north-anchorage strain in row group 1: 169.88 µε");
  test.info().annotations.push({ type: "observed", description: `component requested ${requested} of 1539258 bytes` });
  expect(requested).toBeLessThan(1539258 / 2);
});
