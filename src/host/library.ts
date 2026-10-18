import { DurableObject } from "cloudflare:workers";
import type {
  Annotation,
  AnchorState,
  ArtifactAddress,
  CardView,
  ContentRef,
  DetailView,
  InputFacts,
  PluginManifest,
  PluginRelease,
  ProcessRequest,
  ProcessResult,
  Selector,
  ServiceName,
  TranscriptCue,
} from "../contract";
import { cueText, layerKey, placeAnnotation, type TextLayer } from "./anchors";
import { selectPlugin } from "./select";
import { ARTIFACT_NAME, isServableMediaType, validateResult } from "./validate";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS install (
  plugin_id TEXT PRIMARY KEY, version TEXT NOT NULL, digest TEXT NOT NULL,
  release TEXT NOT NULL, installed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY, input TEXT NOT NULL, current_revision TEXT NOT NULL,
  plugin_id TEXT, alternatives TEXT NOT NULL, process_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS revision (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, revision_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL, digest TEXT NOT NULL, processor TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'committed', 'failed', 'rejected')),
  reason TEXT, bytes_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS artifact (
  run_id TEXT NOT NULL, name TEXT NOT NULL, r2_key TEXT NOT NULL, media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL, PRIMARY KEY (run_id, name));
CREATE TABLE IF NOT EXISTS output (
  item_id TEXT NOT NULL, plugin_id TEXT NOT NULL, processor TEXT NOT NULL, run_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL, revision_id TEXT NOT NULL, result TEXT NOT NULL, committed_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, plugin_id, processor));
CREATE VIRTUAL TABLE IF NOT EXISTS segment USING fts5(
  text, item_id UNINDEXED, run_id UNINDEXED, target UNINDEXED, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS annotation (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, revision_id TEXT NOT NULL, selectors TEXT NOT NULL,
  note TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memo (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cleanup (r2_key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS fault (name TEXT PRIMARY KEY, remaining INTEGER NOT NULL);
`;

export interface RunTicket {
  id: string;
  pluginId: string;
  digest: string;
  request: ProcessRequest;
}

export interface RunContext {
  processor: string;
  services: ServiceName[];
  original: { key: string; sha256: string; byteLength: number; mediaType: string };
}

export type CommitOutcome = { committed: true; duplicate?: true } | { committed: false; reason: string };

export interface ProcessorStatus {
  processor: string;
  state: "pending" | "running" | "committed" | "failed" | "rejected";
  /** Present when an output is visible, possibly from an earlier run than `state` describes. */
  output: { runId: string; pluginVersion: string } | null;
  reason: string | null;
}

export interface ItemResponse {
  id: string;
  input: InputFacts;
  plugin: { id: string; installed: boolean } | null;
  alternatives: string[];
  revision: { id: string; mediaType: string; byteLength: number; url: string };
  card: ResolvedCard;
  detail: ResolvedDetail | null;
  statuses: ProcessorStatus[];
  annotations: (Annotation & { state: AnchorState; time?: { start: number; end: number } })[];
}

export type ResolvedCard = { title: string; subtitle?: string; image: string | null; badges: string[]; processing: boolean };
export type ResolvedDetail =
  | { template: "media"; media: string | null; cues: string | null; thumbnails: string | null; cuesAddress: ArtifactAddress | null }
  | { template: "record"; fields: { label: string; value: string }[]; lists: { label: string; items: string[] }[] }
  | { template: "custom"; component: string; componentUrl: string; data: string | null; fallback: ResolvedDetail };

export interface SearchHit {
  itemId: string;
  title: string;
  snippet: string;
  target: Selector | null;
}

type RunRow = {
  item_id: string;
  revision_id: string;
  plugin_id: string;
  digest: string;
  processor: string;
  state: string;
  reason: string | null;
};

let newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
let now = () => Date.now();

async function sha256Hex(data: string): Promise<string> {
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Library extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private get tenant(): string {
    let name = this.ctx.id.name;
    if (!name) throw new Error("Library must be addressed by tenant name");
    return name;
  }

  private one<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T | undefined {
    return this.sql.exec<T>(query, ...bindings).toArray()[0];
  }

  // -------------------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------------------

  async install(release: PluginRelease): Promise<{ pluginId: string; version: string; digest: string }> {
    let { manifest } = release;
    if (!manifest.processors.includes(manifest.views)) throw new Error("manifest.views must name a processor");
    if (!("processor.js" in release.processorModules)) throw new Error("release must include processor.js");
    let digest = await sha256Hex(JSON.stringify(release));
    this.ctx.storage.transactionSync(() => {
      // Runs pinned to a replaced release can no longer commit.
      this.sql.exec(
        "UPDATE run SET state = 'rejected', reason = 'plugin release changed' WHERE plugin_id = ? AND state = 'running' AND digest != ?",
        manifest.id,
        digest,
      );
      this.sql.exec(
        "INSERT OR REPLACE INTO install (plugin_id, version, digest, release, installed_at) VALUES (?, ?, ?, ?, ?)",
        manifest.id,
        manifest.version,
        digest,
        JSON.stringify(release),
        now(),
      );
    });
    return { pluginId: manifest.id, version: manifest.version, digest };
  }

  /** Stops processing and custom rendering. Outputs, search segments, and annotations stay. */
  async uninstall(pluginId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE run SET state = 'rejected', reason = 'plugin removed' WHERE plugin_id = ? AND state = 'running'", pluginId);
      this.sql.exec("DELETE FROM install WHERE plugin_id = ?", pluginId);
    });
  }

  private installed(pluginId: string): { digest: string; release: PluginRelease } | undefined {
    let row = this.one<{ digest: string; release: string }>("SELECT digest, release FROM install WHERE plugin_id = ?", pluginId);
    return row && { digest: row.digest, release: JSON.parse(row.release) };
  }

  async release(pluginId: string, digest: string): Promise<PluginRelease | null> {
    let install = this.installed(pluginId);
    return install?.digest === digest ? install.release : null;
  }

  async componentModule(pluginId: string, name: string): Promise<string | null> {
    return this.installed(pluginId)?.release.componentModules?.[name] ?? null;
  }

  // -------------------------------------------------------------------------------------
  // Items and runs
  // -------------------------------------------------------------------------------------

  async createItem(
    input: InputFacts,
    original: { key: string; sha256: string; mediaType: string; byteLength: number },
  ): Promise<{ itemId: string; plugin: string | null; workflowId: string | null }> {
    let manifests = this.sql
      .exec<{ release: string }>("SELECT release FROM install")
      .toArray()
      .map((row) => (JSON.parse(row.release) as PluginRelease).manifest);
    let selection = selectPlugin(manifests, {
      mediaType: original.mediaType,
      filename: input.kind === "upload" ? input.filename : undefined,
      url: input.kind === "url" || input.kind === "capture" ? input.url : undefined,
    });
    let itemId = newId();
    let revisionId = newId();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO item (id, input, current_revision, plugin_id, alternatives, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        itemId,
        JSON.stringify(input),
        revisionId,
        selection.plugin,
        JSON.stringify(selection.alternatives),
        now(),
      );
      this.sql.exec(
        "INSERT INTO revision (id, item_id, sha256, media_type, byte_length, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        revisionId,
        itemId,
        original.sha256,
        original.mediaType,
        original.byteLength,
        original.key,
        now(),
      );
    });
    let workflowId = selection.plugin ? await this.startProcessing(itemId) : null;
    return { itemId, plugin: selection.plugin, workflowId };
  }

  async reprocess(itemId: string, processors?: string[]): Promise<{ workflowId: string }> {
    let item = this.one<{ plugin_id: string | null }>("SELECT plugin_id FROM item WHERE id = ?", itemId);
    if (!item?.plugin_id || !this.installed(item.plugin_id)) throw new Error("No installed plugin can process this item");
    return { workflowId: await this.startProcessing(itemId, processors) };
  }

  private async startProcessing(itemId: string, processors?: string[]): Promise<string> {
    let count = this.one<{ process_count: number }>(
      "UPDATE item SET process_count = process_count + 1 WHERE id = ? RETURNING process_count",
      itemId,
    )!.process_count;
    let workflowId = `process-${itemId}-${count}`;
    await this.env.PROCESS.create({ id: workflowId, params: { tenant: this.tenant, itemId, processors } });
    return workflowId;
  }

  /** Pins the installed release and supersedes older runs of the same processor. */
  async startRuns(itemId: string, processors?: string[]): Promise<RunTicket[]> {
    return this.ctx.storage.transactionSync(() => {
      let item = this.one<{ input: string; current_revision: string; plugin_id: string | null }>(
        "SELECT input, current_revision, plugin_id FROM item WHERE id = ?",
        itemId,
      );
      if (!item?.plugin_id) return [];
      let install = this.installed(item.plugin_id);
      if (!install) return [];
      let revision = this.one<{ id: string; sha256: string; media_type: string; byte_length: number }>(
        "SELECT id, sha256, media_type, byte_length FROM revision WHERE id = ?",
        item.current_revision,
      )!;
      let { manifest } = install.release;
      let selected = manifest.processors.filter((name) => !processors || processors.includes(name));
      return selected.map((processor): RunTicket => {
        this.sql.exec(
          "UPDATE run SET state = 'rejected', reason = 'superseded by a newer run' WHERE item_id = ? AND plugin_id = ? AND processor = ? AND state = 'running'",
          itemId,
          manifest.id,
          processor,
        );
        let id = newId();
        this.sql.exec(
          "INSERT INTO run (id, item_id, revision_id, plugin_id, plugin_version, digest, processor, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)",
          id,
          itemId,
          revision.id,
          manifest.id,
          manifest.version,
          install.digest,
          processor,
          now(),
        );
        return {
          id,
          pluginId: manifest.id,
          digest: install.digest,
          request: {
            processor,
            item: { id: itemId, input: JSON.parse(item.input) },
            original: {
              revision: revision.id,
              mediaType: revision.media_type,
              byteLength: revision.byte_length,
              sha256: revision.sha256,
            },
          },
        };
      });
    });
  }

  // Authority for one capability call: the run must still be the current one for its item,
  // revision, and installed release. Revocation therefore applies to in-flight runs too.
  private currentRun(runId: string): { ok: false; error: string } | { ok: true; run: RunRow; release: PluginRelease } {
    let run = this.one<RunRow>("SELECT item_id, revision_id, plugin_id, digest, processor, state, reason FROM run WHERE id = ?", runId);
    if (!run) return { ok: false, error: "unknown run" };
    if (run.state !== "running") return { ok: false, error: run.reason ?? `run is ${run.state}` };
    let item = this.one<{ current_revision: string }>("SELECT current_revision FROM item WHERE id = ?", run.item_id);
    if (!item) return { ok: false, error: "item deleted" };
    if (item.current_revision !== run.revision_id) return { ok: false, error: "item has a newer revision" };
    let install = this.installed(run.plugin_id);
    if (!install || install.digest !== run.digest) return { ok: false, error: "plugin release changed or removed" };
    return { ok: true, run, release: install.release };
  }

  async runContext(runId: string): Promise<RunContext> {
    let current = this.currentRun(runId);
    if (!current.ok) throw new Error(`Run ${runId} cannot act: ${current.error}`);
    let revision = this.one<{ r2_key: string; sha256: string; byte_length: number; media_type: string }>(
      "SELECT r2_key, sha256, byte_length, media_type FROM revision WHERE id = ?",
      current.run.revision_id,
    )!;
    return {
      processor: current.run.processor,
      services: current.release.manifest.services,
      original: { key: revision.r2_key, sha256: revision.sha256, byteLength: revision.byte_length, mediaType: revision.media_type },
    };
  }

  async recordRead(runId: string, bytes: number): Promise<void> {
    this.sql.exec("UPDATE run SET bytes_read = bytes_read + ? WHERE id = ?", bytes, runId);
  }

  /** Registers before the R2 write so a failed write stays tracked; a retry reuses the key. */
  async stageArtifact(runId: string, name: string, mediaType: string, byteLength: number): Promise<{ key: string; processor: string }> {
    let current = this.currentRun(runId);
    if (!current.ok) throw new Error(`Run ${runId} cannot act: ${current.error}`);
    if (!ARTIFACT_NAME.test(name)) throw new Error(`Invalid artifact name: ${name}`);
    if (!isServableMediaType(mediaType)) throw new Error(`Media type ${mediaType} cannot be stored`);
    let key = `t/${this.tenant}/runs/${runId}/${name}`;
    this.sql.exec(
      "INSERT OR REPLACE INTO artifact (run_id, name, r2_key, media_type, byte_length) VALUES (?, ?, ?, ?, ?)",
      runId,
      name,
      key,
      mediaType,
      byteLength,
    );
    return { key, processor: current.run.processor };
  }

  async commitRun(runId: string, result: ProcessResult): Promise<CommitOutcome> {
    let outcome = this.ctx.storage.transactionSync((): CommitOutcome => {
      let state = this.one<{ state: string }>("SELECT state FROM run WHERE id = ?", runId)?.state;
      if (state === "committed") return { committed: true, duplicate: true };
      let current = this.currentRun(runId);
      if (!current.ok) return this.reject(runId, current.error);
      let { run, release } = current;
      let stagedNames = new Set(this.sql.exec<{ name: string }>("SELECT name FROM artifact WHERE run_id = ?", runId).toArray().map((row) => row.name));
      let problems: string[];
      try {
        problems = validateResult(result, {
          manifest: release.manifest,
          processor: run.processor,
          stagedNames,
          componentNames: new Set(Object.keys(release.componentModules ?? {})),
        });
      } catch {
        problems = ["result is malformed"];
      }
      if (problems.length) return this.reject(runId, `invalid result: ${problems.slice(0, 5).join("; ")}`);

      let previous = this.one<{ run_id: string }>(
        "SELECT run_id FROM output WHERE item_id = ? AND plugin_id = ? AND processor = ?",
        run.item_id,
        run.plugin_id,
        run.processor,
      );
      if (previous) this.discardArtifacts(previous.run_id);
      for (let segment of result.search ?? []) {
        this.sql.exec(
          "INSERT INTO segment (text, item_id, run_id, target) VALUES (?, ?, ?, ?)",
          segment.text,
          run.item_id,
          runId,
          segment.target ? JSON.stringify(segment.target) : null,
        );
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO output (item_id, plugin_id, processor, run_id, plugin_version, revision_id, result, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        run.item_id,
        run.plugin_id,
        run.processor,
        runId,
        release.manifest.version,
        run.revision_id,
        JSON.stringify({ views: result.views }),
        now(),
      );
      this.sql.exec("UPDATE run SET state = 'committed' WHERE id = ?", runId);
      return { committed: true };
    });
    await this.scheduleCleanup();
    return outcome;
  }

  async failRun(runId: string, reason: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      let updated = this.sql.exec("UPDATE run SET state = 'failed', reason = ? WHERE id = ? AND state = 'running' RETURNING id", reason.slice(0, 500), runId).toArray();
      if (updated.length) this.discardArtifacts(runId);
    });
    await this.scheduleCleanup();
  }

  private reject(runId: string, reason: string): CommitOutcome {
    this.sql.exec("UPDATE run SET state = 'rejected', reason = ? WHERE id = ? AND state = 'running'", reason.slice(0, 500), runId);
    this.discardArtifacts(runId);
    return { committed: false, reason };
  }

  private discardArtifacts(runId: string) {
    this.sql.exec("INSERT OR IGNORE INTO cleanup (r2_key) SELECT r2_key FROM artifact WHERE run_id = ?", runId);
    this.sql.exec("DELETE FROM artifact WHERE run_id = ?", runId);
    this.sql.exec("DELETE FROM segment WHERE run_id = ?", runId);
  }

  async deleteItem(itemId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (let { id } of this.sql.exec<{ id: string }>("SELECT id FROM run WHERE item_id = ?", itemId).toArray()) this.discardArtifacts(id);
      this.sql.exec("INSERT OR IGNORE INTO cleanup (r2_key) SELECT r2_key FROM revision WHERE item_id = ?", itemId);
      this.sql.exec("UPDATE run SET state = 'rejected', reason = 'item deleted' WHERE item_id = ? AND state = 'running'", itemId);
      for (let table of ["output", "annotation", "revision", "item"]) {
        this.sql.exec(`DELETE FROM ${table} WHERE ${table === "item" ? "id" : "item_id"} = ?`, itemId);
      }
    });
    await this.scheduleCleanup();
  }

  private async scheduleCleanup() {
    if (this.one("SELECT r2_key FROM cleanup LIMIT 1") && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now());
    }
  }

  async alarm() {
    let keys = this.sql.exec<{ r2_key: string }>("SELECT r2_key FROM cleanup LIMIT 500").toArray().map((row) => row.r2_key);
    if (!keys.length) return;
    await this.env.BLOBS.delete(keys);
    for (let key of keys) this.sql.exec("DELETE FROM cleanup WHERE r2_key = ?", key);
    await this.scheduleCleanup();
  }

  // -------------------------------------------------------------------------------------
  // Host service support: memoized results and test-only fault injection
  // -------------------------------------------------------------------------------------

  async memoGet(key: string): Promise<string | null> {
    return this.one<{ value: string }>("SELECT value FROM memo WHERE key = ?", key)?.value ?? null;
  }

  async memoPut(key: string, value: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO memo (key, value) VALUES (?, ?)", key, value);
  }

  async setFault(name: string, remaining: number): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO fault (name, remaining) VALUES (?, ?)", name, remaining);
  }

  async consumeFault(name: string): Promise<boolean> {
    return this.sql.exec("UPDATE fault SET remaining = remaining - 1 WHERE name = ? AND remaining > 0 RETURNING remaining", name).toArray().length > 0;
  }

  async runsFor(itemId: string): Promise<{ id: string; processor: string; state: string; reason: string | null; bytesRead: number; pluginVersion: string }[]> {
    return this.sql
      .exec<{ id: string; processor: string; state: string; reason: string | null; bytes_read: number; plugin_version: string }>(
        "SELECT id, processor, state, reason, bytes_read, plugin_version FROM run WHERE item_id = ? ORDER BY created_at, rowid",
        itemId,
      )
      .toArray()
      .map((row) => ({ id: row.id, processor: row.processor, state: row.state, reason: row.reason, bytesRead: row.bytes_read, pluginVersion: row.plugin_version }));
  }

  // -------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------

  private outputs(itemId: string, pluginId: string) {
    let rows = this.sql
      .exec<{ processor: string; run_id: string; plugin_version: string; result: string }>(
        "SELECT processor, run_id, plugin_version, result FROM output WHERE item_id = ? AND plugin_id = ?",
        itemId,
        pluginId,
      )
      .toArray();
    return new Map(rows.map((row) => [row.processor, { runId: row.run_id, pluginVersion: row.plugin_version, result: JSON.parse(row.result) as ProcessResult }]));
  }

  private resolveRef(itemId: string, outputs: ReturnType<Library["outputs"]>, ref: ContentRef | undefined): string | null {
    if (ref === undefined) return null;
    if (ref === "original") return `/api/items/${itemId}/original`;
    let output = outputs.get(ref.processor);
    if (!output) return null;
    let exists = this.one("SELECT name FROM artifact WHERE run_id = ? AND name = ?", output.runId, ref.name);
    return exists ? `/api/items/${itemId}/artifacts/${output.runId}/${ref.name}` : null;
  }

  private resolveDetail(itemId: string, pluginId: string, outputs: ReturnType<Library["outputs"]>, detail: DetailView): ResolvedDetail {
    if (detail.template === "media") {
      return {
        template: "media",
        media: this.resolveRef(itemId, outputs, detail.media),
        cues: this.resolveRef(itemId, outputs, detail.cues),
        thumbnails: this.resolveRef(itemId, outputs, detail.thumbnails),
        cuesAddress: detail.cues ?? null,
      };
    }
    if (detail.template === "record") return { template: "record", fields: detail.fields, lists: detail.lists ?? [] };
    let fallback = this.resolveDetail(itemId, pluginId, outputs, detail.fallback);
    let install = this.installed(pluginId);
    if (!install?.release.componentModules?.[detail.component]) return fallback;
    return {
      template: "custom",
      component: detail.component,
      componentUrl: `/api/plugins/${pluginId}/components/${detail.component}`,
      data: this.resolveRef(itemId, outputs, detail.data),
      fallback,
    };
  }

  private card(itemId: string, input: InputFacts, outputs: ReturnType<Library["outputs"]>, viewsProcessor: string | undefined): ResolvedCard {
    let card: CardView | undefined = viewsProcessor ? outputs.get(viewsProcessor)?.result.views?.card : undefined;
    let fallbackTitle = input.kind === "upload" ? input.filename : input.kind === "authored" ? "Untitled" : input.url;
    let processing = this.one(`SELECT id FROM run WHERE item_id = ? AND state = 'running' LIMIT 1`, itemId) !== undefined;
    if (!card) return { title: fallbackTitle, image: null, badges: [], processing };
    return { title: card.title, subtitle: card.subtitle, image: this.resolveRef(itemId, outputs, card.image), badges: card.badges ?? [], processing };
  }

  // Which processor supplies views is recorded in the manifest. A removed plugin's outputs
  // remain, so fall back to whichever stored output carries views.
  private viewsProcessor(pluginId: string, outputs: ReturnType<Library["outputs"]>): string | undefined {
    return this.installed(pluginId)?.release.manifest.views ?? [...outputs].find(([, output]) => output.result.views)?.[0];
  }

  async listItems(): Promise<(ResolvedCard & { id: string })[]> {
    let items = this.sql.exec<{ id: string; input: string; plugin_id: string | null }>("SELECT id, input, plugin_id FROM item ORDER BY created_at DESC").toArray();
    return items.map((item) => {
      let outputs = item.plugin_id ? this.outputs(item.id, item.plugin_id) : new Map();
      return { id: item.id, ...this.card(item.id, JSON.parse(item.input), outputs, item.plugin_id ? this.viewsProcessor(item.plugin_id, outputs) : undefined) };
    });
  }

  private async textLayer(itemId: string, outputs: ReturnType<Library["outputs"]>, address: ArtifactAddress): Promise<TextLayer | undefined> {
    let output = outputs.get(address.processor);
    if (!output) return undefined;
    let artifact = this.one<{ r2_key: string; media_type: string }>("SELECT r2_key, media_type FROM artifact WHERE run_id = ? AND name = ?", output.runId, address.name);
    if (!artifact) return undefined;
    let object = await this.env.BLOBS.get(artifact.r2_key);
    if (!object) return undefined;
    if (artifact.media_type !== "application/json") return { text: await object.text() };
    // A plugin wrote this file; a malformed one leaves its quotes unplaceable, nothing more.
    try {
      let { cues } = await object.json<{ cues: TranscriptCue[] }>();
      if (cues.every((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && typeof cue.text === "string")) return { text: cueText(cues), cues };
    } catch {}
    return undefined;
  }

  async getItem(itemId: string): Promise<ItemResponse | null> {
    let item = this.one<{ input: string; current_revision: string; plugin_id: string | null; alternatives: string }>(
      "SELECT input, current_revision, plugin_id, alternatives FROM item WHERE id = ?",
      itemId,
    );
    if (!item) return null;
    let input: InputFacts = JSON.parse(item.input);
    let revision = this.one<{ media_type: string; byte_length: number }>("SELECT media_type, byte_length FROM revision WHERE id = ?", item.current_revision)!;
    let pluginId = item.plugin_id;
    let outputs = pluginId ? this.outputs(itemId, pluginId) : new Map();
    let manifest: PluginManifest | undefined = pluginId ? this.installed(pluginId)?.release.manifest : undefined;
    let viewsProcessor = pluginId ? this.viewsProcessor(pluginId, outputs) : undefined;
    let detailView = viewsProcessor ? outputs.get(viewsProcessor)?.result.views?.detail : undefined;

    let processors = manifest?.processors ?? [...outputs.keys()];
    let statuses = processors.map((processor): ProcessorStatus => {
      let latest = this.one<{ state: ProcessorStatus["state"]; reason: string | null }>(
        "SELECT state, reason FROM run WHERE item_id = ? AND processor = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        itemId,
        processor,
      );
      let output = outputs.get(processor);
      return {
        processor,
        state: latest?.state ?? "pending",
        output: output ? { runId: output.runId, pluginVersion: output.pluginVersion } : null,
        reason: latest?.reason ?? null,
      };
    });

    let annotations = this.sql
      .exec<{ id: string; revision_id: string; selectors: string; note: string | null; created_at: number }>(
        "SELECT id, revision_id, selectors, note, created_at FROM annotation WHERE item_id = ? ORDER BY created_at, rowid",
        itemId,
      )
      .toArray();
    let layers = new Map<string, TextLayer>();
    for (let row of annotations) {
      for (let selector of JSON.parse(row.selectors) as Selector[]) {
        if (selector.type !== "text-quote" || layers.has(layerKey(selector.in))) continue;
        let layer = await this.textLayer(itemId, outputs, selector.in);
        if (layer) layers.set(layerKey(selector.in), layer);
      }
    }
    return {
      id: itemId,
      input,
      plugin: pluginId ? { id: pluginId, installed: manifest !== undefined } : null,
      alternatives: JSON.parse(item.alternatives),
      revision: { id: item.current_revision, mediaType: revision.media_type, byteLength: revision.byte_length, url: `/api/items/${itemId}/original` },
      card: this.card(itemId, input, outputs, viewsProcessor),
      detail: detailView && pluginId ? this.resolveDetail(itemId, pluginId, outputs, detailView) : null,
      statuses,
      annotations: annotations.map((row) => {
        let selectors: Selector[] = JSON.parse(row.selectors);
        let placement = placeAnnotation(selectors, row.revision_id, { revision: item.current_revision, layers });
        return { id: row.id, item: itemId, revision: row.revision_id, selectors, note: row.note, createdAt: row.created_at, ...placement };
      }),
    };
  }

  async search(query: string): Promise<SearchHit[]> {
    // Quote each term so user input cannot use FTS5 query syntax.
    let terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!terms.length) return [];
    let rows = this.sql
      .exec<{ item_id: string; snippet: string; target: string | null }>(
        `SELECT item_id, snippet(segment, 0, '[', ']', '…', 12) AS snippet, target FROM segment
         WHERE segment MATCH ? ORDER BY bm25(segment) LIMIT 50`,
        terms.map((term) => `"${term}"`).join(" "),
      )
      .toArray();
    let titles = new Map((await this.listItems()).map((card) => [card.id, card.title]));
    return rows.map((row) => ({ itemId: row.item_id, title: titles.get(row.item_id) ?? row.item_id, snippet: row.snippet, target: row.target ? JSON.parse(row.target) : null }));
  }

  async addAnnotation(itemId: string, selectors: Selector[], note: string | null): Promise<Annotation> {
    let item = this.one<{ current_revision: string; plugin_id: string | null }>("SELECT current_revision, plugin_id FROM item WHERE id = ?", itemId);
    if (!item) throw new Error("Item not found");
    if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 4) throw new Error("Expected 1-4 selectors");
    for (let selector of selectors) {
      let valid =
        (selector.type === "time" && Number.isFinite(selector.start) && Number.isFinite(selector.end) && selector.start >= 0 && selector.end >= selector.start) ||
        (selector.type === "text-quote" && typeof selector.exact === "string" && selector.exact.length > 0 && selector.exact.length <= 1000 && ARTIFACT_NAME.test(selector.in?.name ?? "")) ||
        (selector.type === "plugin" && selector.plugin === item.plugin_id && typeof selector.value === "string" && selector.value.length <= 500 && typeof selector.label === "string" && selector.label.length <= 200);
      if (!valid) throw new Error(`Invalid ${String(selector.type)} selector`);
    }
    if (note !== null && (typeof note !== "string" || note.length > 10_000)) throw new Error("Invalid note");
    let annotation: Annotation = { id: newId(), item: itemId, revision: item.current_revision, selectors, note, createdAt: now() };
    this.sql.exec(
      "INSERT INTO annotation (id, item_id, revision_id, selectors, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      annotation.id,
      itemId,
      annotation.revision,
      JSON.stringify(selectors),
      note,
      annotation.createdAt,
    );
    return annotation;
  }

  /** Storage key for an artifact the browser may read: only the item's current outputs. */
  async servableArtifact(itemId: string, runId: string, name: string): Promise<{ key: string; mediaType: string } | null> {
    let row = this.one<{ r2_key: string; media_type: string }>(
      `SELECT artifact.r2_key, artifact.media_type FROM artifact JOIN output ON output.run_id = artifact.run_id
       WHERE output.item_id = ? AND artifact.run_id = ? AND artifact.name = ?`,
      itemId,
      runId,
      name,
    );
    return row ? { key: row.r2_key, mediaType: row.media_type } : null;
  }

  async servableOriginal(itemId: string): Promise<{ key: string; mediaType: string; byteLength: number } | null> {
    let row = this.one<{ r2_key: string; media_type: string; byte_length: number }>(
      "SELECT revision.r2_key, revision.media_type, revision.byte_length FROM revision JOIN item ON item.current_revision = revision.id WHERE item.id = ?",
      itemId,
    );
    return row ? { key: row.r2_key, mediaType: row.media_type, byteLength: row.byte_length } : null;
  }
}
