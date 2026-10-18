import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ remoteBindings: false, wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { exclude: [...configDefaults.exclude, "browser/**"] },
});
