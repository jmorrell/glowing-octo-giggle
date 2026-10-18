import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "browser",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:8799" },
  webServer: {
    // Local workerd via Wrangler, with state discarded between runs.
    command: "rm -rf .wrangler/browser-state && npx wrangler dev --port 8799 --ip 127.0.0.1 --persist-to .wrangler/browser-state",
    url: "http://127.0.0.1:8799/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
