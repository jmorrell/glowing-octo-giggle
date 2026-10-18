import { expect, test } from "@playwright/test";
import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { install, upload } from "./helpers";

test.describe("isolated custom component", () => {
  test("annotates a part from inside the viewer, with the note collected and saved by host chrome", async ({ page, request }) => {
    await install(request, "cad@1.0.0");
    let itemId = await upload(request, "fixtures/bracket-assembly.step", "application/octet-stream");
    await page.goto(`/items/${itemId}`);
    let viewer = page.frameLocator("iframe.component");

    await viewer.getByRole("button", { name: "Mounting bracket" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#composer-label")).toHaveText("Mounting bracket (#10)");
    await page.getByLabel("Note").fill("Check the weld");
    await page.getByRole("button", { name: "Save note" }).click();

    await expect(page.locator("#annotations li")).toHaveText(["Mounting bracket (#10)Check the welddelegated"]);
    await expect(viewer.getByRole("button", { name: "Mounting bracket" }).locator(".marker")).toBeVisible();
    await page.reload();
    await expect(viewer.getByRole("button", { name: "Mounting bracket" }).locator(".marker")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Base plate" }).locator(".marker")).toHaveCount(0);

    let item = await (await request.get(`/api/items/${itemId}`)).json();
    expect(item.annotations).toMatchObject([
      { note: "Check the weld", state: "delegated", selectors: [{ type: "plugin", plugin: "example.cad", value: "#10", label: "Mounting bracket (#10)" }] },
    ]);
  });

  test("opens a search hit focused on the part it names", async ({ page, request }) => {
    await install(request, "cad@1.0.0");
    await upload(request, "fixtures/bracket-assembly.step", "application/octet-stream");
    await page.goto("/");
    await page.getByLabel("Search").fill("aluminium");
    await page.getByRole("button", { name: "Search" }).click();
    await page.locator("#results a").first().click();
    await expect(page.frameLocator("iframe.component").getByRole("button", { name: "Base plate" })).toHaveClass("focused");
  });

  test.describe("containment", () => {
    let requests: string[] = [];
    let datagrams = 0;
    let http: Server;
    let udp: Socket;

    test.beforeAll(async () => {
      http = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.end("ok");
      }).listen(8798, "127.0.0.1");
      udp = createSocket("udp4").on("message", () => datagrams++);
      await new Promise<void>((resolve) => udp.bind(3478, "127.0.0.1", resolve));
    });
    test.afterAll(() => {
      http.close();
      udp.close();
    });

    for (let mode of ["host CSP", "no host CSP"] as const) {
      test(`what a hostile component can reach (${mode})`, async ({ page, request }) => {
        requests = [];
        datagrams = 0;
        await install(request, "hostile-ui@1.0.0");
        writeFileSync(test.info().outputPath("x.probe"), "probe");
        let itemId = await upload(request, test.info().outputPath("x.probe"), "application/octet-stream");
        await page.addInitScript(() => {
          addEventListener("component-report", (event) => ((window as unknown as { report: unknown }).report = (event as CustomEvent).detail));
        });
        await page.goto(`/items/${itemId}${mode === "no host CSP" ? "?containment=weak" : ""}`);
        let report = (await (await page.waitForFunction(() => (window as unknown as { report?: unknown }).report)).jsonValue()) as Record<string, string>;
        await page.waitForTimeout(1500); // let a successful self-navigation reach the sink
        test.info().annotations.push({ type: "observed", description: JSON.stringify({ report, sinkRequests: requests, datagrams }) });

        // Same-origin data and host chrome stay out of reach in both modes.
        for (let probe of ["fetch host API", "fetch sink", "read parent DOM", "read cookies", "localStorage", "image beacon", "host media", "popup", "navigate top", "WebAssembly", "Web Worker"]) {
          expect(report[probe], probe).toMatch(/^denied/);
        }
        expect(requests.filter((url) => url !== "/navigate?leak=1")).toEqual([]);
        // Known limits: WebRTC is not governed by CSP, and frame self-navigation is
        // stopped only by the host page's frame-src.
        expect(report["WebRTC to STUN"]).toMatch(/^allowed/);
        expect(datagrams).toBeGreaterThan(0);
        expect(requests.includes("/navigate?leak=1")).toBe(mode === "no host CSP");
        expect(report["base URL"]).toBe(`allowed: http://127.0.0.1:8799/items/${itemId}${mode === "no host CSP" ? "?containment=weak" : ""}`);
      });
    }
  });
});
