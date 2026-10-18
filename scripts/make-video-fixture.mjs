// Records a 15-second synthetic WebM (VP8) in Chromium so the media template can be tested
// with a file the browser can actually play and seek. Output: fixtures/inspection.webm
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

let browser = await chromium.launch();
let page = await browser.newPage();
let base64 = await page.evaluate(async () => {
  let canvas = Object.assign(document.createElement("canvas"), { width: 160, height: 90 });
  let context = canvas.getContext("2d");
  let recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 60_000 });
  let chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  let started = performance.now();
  let draw = () => {
    let t = (performance.now() - started) / 1000;
    context.fillStyle = `hsl(${(t * 24) % 360} 60% 45%)`;
    context.fillRect(0, 0, 160, 90);
    context.fillStyle = "#fff";
    context.font = "20px sans-serif";
    context.fillText(`${t.toFixed(1)} s`, 40, 52);
  };
  let timer = setInterval(draw, 50);
  draw();
  recorder.start(1000);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  recorder.stop();
  await new Promise((resolve) => (recorder.onstop = resolve));
  clearInterval(timer);
  let bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
});
writeFileSync("fixtures/inspection.webm", Buffer.from(base64, "base64"));
await browser.close();
console.log(`wrote fixtures/inspection.webm (${Buffer.from(base64, "base64").length} bytes)`);
