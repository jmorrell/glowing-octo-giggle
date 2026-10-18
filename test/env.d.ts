declare module "*?raw" {
  const content: string;
  export default content;
}

// Test-only binding supplied by vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    PARQUET_FIXTURE: string;
  }
}
