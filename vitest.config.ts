import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      // Binary fixtures for tests that run inside workerd, which cannot read the repository.
      miniflare: { bindings: { PARQUET_FIXTURE: readFileSync("fixtures/bridge-sensors.parquet").toString("base64") } },
    }),
  ],
  test: { exclude: [...configDefaults.exclude, "browser/**"] },
});
