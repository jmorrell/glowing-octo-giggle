import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProcessRequest, ProcessResult } from "../contract";

export type ProcessParams = { tenant: string; itemId: string; processors?: string[] };

// One step per processor: a committed output survives later failures, and a retry repeats
// only the processor that failed. Commit happens inside the step because results can exceed
// the 1 MiB step-result limit; Library.commitRun is idempotent per run for step replays.
export class ProcessWorkflow extends WorkflowEntrypoint<Env, ProcessParams> {
  async run(event: WorkflowEvent<ProcessParams>, step: WorkflowStep) {
    let { tenant, itemId, processors } = event.payload;
    let library = this.env.LIBRARY.getByName(tenant);
    let runs = await step.do("start runs", () => library.startRuns(itemId, processors));
    let outcomes: Record<string, { committed: boolean; reason?: string }> = {};
    for (let run of runs) {
      let name = run.request.processor;
      try {
        outcomes[name] = await step.do(`process ${name}`, { retries: { limit: 2, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" }, async () => {
          let release = await library.release(run.pluginId, run.digest);
          if (!release) {
            // The pinned release was replaced or removed; committing rejects the run.
            let outcome = await library.commitRun(run.id, {});
            return { committed: false as const, reason: outcome.committed ? "unexpected commit" : outcome.reason };
          }
          // The isolate is cached per tenant and release. Its env is empty and identical for
          // every caller; per-run authority travels only as the `host` argument below.
          let worker = this.env.LOADER.get(`${tenant}:${run.pluginId}@${run.digest}`, async () => ({
            compatibilityDate: "2026-09-29",
            mainModule: "processor.js",
            modules: release.processorModules,
            env: {},
            globalOutbound: null,
          }));
          let host = this.ctx.exports.PluginHost({ props: { tenant, runId: run.id } });
          // The plugin implements ProcessorEntrypoint; the loader cannot type a dynamic module.
          let processor = worker.getEntrypoint() as unknown as { process(request: ProcessRequest, host: unknown): Promise<ProcessResult> };
          let result = await processor.process(run.request, host);
          let outcome = await library.commitRun(run.id, result);
          return outcome.committed ? { committed: true as const } : { committed: false as const, reason: outcome.reason };
        });
      } catch (error) {
        let reason = error instanceof Error ? error.message : String(error);
        await step.do(`fail ${name}`, () => library.failRun(run.id, reason));
        outcomes[name] = { committed: false, reason };
      }
    }
    return outcomes;
  }
}
