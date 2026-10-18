// Installs the example plugins and uploads the fixtures into a running `npm run dev` server.
// Usage: node scripts/seed-dev.mjs [base URL, default http://127.0.0.1:8799]
import { build } from "esbuild";
import { readFileSync } from "node:fs";

let base = process.argv[2] ?? "http://127.0.0.1:8799";
let out = await build({ entryPoints: ["src/generated/releases.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "error" });
let { releases } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
for (let key of ["video@1.0.0", "cad@1.0.0"]) {
  let response = await fetch(`${base}/api/plugins`, { method: "POST", body: JSON.stringify(releases[key]) });
  console.log("install", key, response.status);
}
for (let [file, mediaType] of [["fixtures/inspection.webm", "video/webm"], ["fixtures/bracket-assembly.step", "application/octet-stream"]]) {
  let response = await fetch(`${base}/api/items`, { method: "POST", body: readFileSync(file), headers: { "Content-Type": mediaType, "X-Filename": file.split("/").pop() } });
  console.log("upload", file, response.status, await response.text());
}
