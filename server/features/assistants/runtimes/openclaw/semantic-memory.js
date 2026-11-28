import path from "node:path";
import { readJSON, writePrivate } from "../../../../lib/storage.js";
import { durablePrivate } from "../../runtime-update-snapshot.js";
import { runtimeManifest } from "./runtime-manifest.js";
import {
  embeddingPaths,
  embeddingPlatformProblem,
  ensureEmbeddingModel,
  ensureEmbeddingServer,
  installedEmbeddingModel,
  installedEmbeddingServer,
  removeEmbeddingModel,
  removeEmbeddingServer,
  verifyEmbeddingModel,
} from "./embedding-assets.js";
import { reclaimEmbeddingServer } from "./embedding-server.js";
import { indexedAgents, rebuildMemoryIndex } from "./memory-index.js";
import {
  compiledSemantic,
  withoutSemanticMemory,
} from "./openclaw-config/semantic-memory.js";

/*
 * The owner's semantic memory search (docs/assistant-gateway.md, "Semantic memory
 * search"): one switch for every agent on the shared OpenClaw Gateway. Off, memory
 * search matches words (OpenClaw's `provider: "none"`, the default). On, notes and
 * queries are embedded by a local model, so a search finds notes by meaning.
 *
 * OpenClaw pauses an agent's whole memory search once openclaw.json names another
 * embedding provider than its index was built with, and rebuilds an index only while
 * the Gateway is stopped (memory-index.js). Three records keep the two in step:
 *
 * - the setting (`<assistants>/semantic-memory.json`): `enabled`, the last `failure`,
 *   an `intent` while an operation the owner started runs and a `journal` while a
 *   rebuild runs. Not part of an update snapshot.
 * - the index marker (`<state>/agentpier-memory-index.json`): the mode every index
 *   was last rebuilt for. It lives in the Gateway's state tree, so an update
 *   snapshot, its rollback and a host backup carry it together with the indexes.
 *   Without one the indexes are keyword indexes (every installation before this).
 * - the assets (embedding-assets.js).
 *
 * Every Gateway start reconciles them before the spawn (`beforeSpawn`): it compiles
 * local embeddings only while the setting is on and plugin, server and model are
 * there (`compiled`), and rebuilds every index whenever the marker names another
 * mode than the start compiles, or an earlier rebuild did not finish. Switching on or
 * off is therefore: prepare the assets, save the setting, restart the Gateway. A
 * failed or interrupted rebuild for local embeddings switches the setting off with
 * its reason and rebuilds the keyword indexes, so memory search is never left paused.
 *
 * "On" is only shown while it is true. Once the indexes are built, a local provider
 * that cannot answer (a system library removed, the server or the model gone) does
 * not pause the search: OpenClaw answers with keyword hits alone and says so only in
 * the search result (`details.provider` is "none" instead of "local"; verified on
 * 2026.11.6, whose `memory.status` and `doctor.memory.status` RPCs report the same
 * for a working and a broken provider). The status is therefore "degraded", with a
 * reason, when the installed server or model is missing (a cheap look at each status
 * read) or a memory search answered without embeddings (`observe`, `check`). The
 * same Gateway process does not recover by itself; the owner's "Repair" installs the
 * assets again, restarts and rebuilds.
 */
export const stateFile = "semantic-memory.json";
export const markerFile = "agentpier-memory-index.json";
const failure = (code, status = 409) => Object.assign(Error(code), { code, status });
const stable = (error, fallback) =>
  /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : fallback;

export class SemanticMemory {
  /**
   * - `supervisor`: the RuntimeSupervisor (`paths`, `runtime`, `status()`).
   * - `restart()`: restarts the Gateway as the owner's "Restart now" does (running
   *   agent work is interrupted); rejects when it may not restart now.
   * - `changed()`: the view changed (the live topic is signalled).
   * - `assets`, `rebuild`, `reclaim`: the asset functions, the index rebuild and the
   *   orphan stop; tests replace them.
   */
  constructor({
    supervisor,
    restart,
    changed = () => {},
    manifest = runtimeManifest,
    assets = {},
    rebuild = rebuildMemoryIndex,
    reclaim = reclaimEmbeddingServer,
    host = { platform: process.platform, arch: process.arch },
    now = Date.now,
    warn = console.warn,
  }) {
    Object.assign(this, { supervisor, restart, manifest, rebuild, reclaim, host, now });
    Object.assign(this, { warn, notify: changed });
    this.assets = {
      ensureServer: ensureEmbeddingServer,
      ensureModel: ensureEmbeddingModel,
      verifyModel: verifyEmbeddingModel,
      removeModel: removeEmbeddingModel,
      removeServer: removeEmbeddingServer,
      installedServer: installedEmbeddingServer,
      installedModel: installedEmbeddingModel,
      ...assets,
    };
    this.tail = Promise.resolve();
    this.operation = null;
    // What memory searches of the running Gateway showed: `{ code, at }` once one
    // answered without embeddings, and when the last check ran.
    this.health = null;
    this.checkedAt = null;
    this.abort = new AbortController();
    this.recover();
  }
  // What the previous AgentPier process did not finish: a rebuild for local
  // embeddings (its journal stays, so the next start rebuilds the keyword indexes)
  // or a download switches the setting off as interrupted; anything else the next
  // start completes by itself.
  recover() {
    const state = this.read();
    const rebuilding = state.enabled && state.journal?.target === "local";
    const downloading =
      !state.enabled && !state.failure && state.intent?.target === "local";
    if (!state.intent && !rebuilding) return;
    this.write({
      ...state,
      intent: null,
      ...((rebuilding || downloading) && {
        enabled: false,
        failure: { code: "INTERRUPTED", at: this.now() },
      }),
    });
  }
  get root() {
    return this.supervisor.paths.root;
  }
  get paths() {
    return embeddingPaths(this.root, this.manifest, this.host);
  }
  read() {
    let stored = null;
    try {
      stored = readJSON(path.join(this.root, stateFile), null);
    } catch {
      // A damaged file reads as the default: off.
    }
    return {
      enabled: stored?.enabled === true,
      revision: Number.isInteger(stored?.revision) ? stored.revision : 1,
      failure: typeof stored?.failure?.code === "string" ? stored.failure : null,
      intent: stored?.intent?.target ? stored.intent : null,
      journal: stored?.journal?.target ? stored.journal : null,
    };
  }
  write(state) {
    durablePrivate(path.join(this.root, stateFile), state);
    this.changed();
  }
  update(patch) {
    const next = { ...this.read(), ...patch };
    this.write(next);
    return next;
  }
  changed() {
    try {
      this.notify();
    } catch {
      /* A listener's failure never fails the operation. */
    }
  }
  /** The mode every agent's index was last rebuilt for, and for which model. */
  marker() {
    try {
      const stored = readJSON(path.join(this.supervisor.paths.state, markerFile), null);
      if (stored?.mode === "local" && typeof stored.model === "string")
        return { mode: "local", model: stored.model };
    } catch {
      // Unreadable: rebuilt as keyword indexes unless the start compiles local.
      return { mode: "unknown", model: null };
    }
    return { mode: "keyword", model: null };
  }
  mark(mode) {
    writePrivate(path.join(this.supervisor.paths.state, markerFile), {
      mode,
      model: mode === "local" ? this.manifest.embeddingModel.sha256 : null,
    });
  }
  /**
   * Why local embeddings cannot run with the installed runtime `installed` (its
   * descriptor), as a stable code, or null: the platform has no pinned server build,
   * the runtime was installed before the plugin was bundled (activate the update),
   * or the server or the model is not installed.
   */
  unusable(installed, { assets = true } = {}) {
    const platform = embeddingPlatformProblem(this.manifest, this.host);
    if (platform) return platform;
    if (installed && !installed.embeddingPlugin?.directory)
      return "RUNTIME_UPDATE_REQUIRED";
    if (!assets) return null;
    if (!this.assets.installedServer(this.root, this.manifest, this.host))
      return "EMBEDDING_SERVER_MISSING";
    if (!this.assets.installedModel(this.root, this.manifest))
      return "EMBEDDING_MODEL_MISSING";
    return null;
  }
  /**
   * What a Gateway start on the installed runtime `installed` compiles (desiredState's
   * `semanticMemory`), or undefined for keyword search. A setting that is on but
   * cannot run, and a rebuild for local embeddings an earlier start left unfinished,
   * switch the setting off with their reason first: the start then compiles keyword
   * search and `beforeSpawn` rebuilds the indexes for it.
   */
  compiled(installed) {
    const state = this.read();
    if (!state.enabled) return undefined;
    const problem =
      state.journal?.target === "local" ? "INTERRUPTED" : this.unusable(installed);
    if (problem) {
      this.update({ enabled: false, failure: { code: problem, at: this.now() } });
      return undefined;
    }
    const paths = this.paths;
    return {
      plugin: installed.embeddingPlugin,
      command: paths.command,
      model: paths.model,
      modelCacheDir: paths.models,
      preset: paths.preset,
      pidFile: paths.pidFile,
    };
  }
  /**
   * Before a Gateway spawn, with this start's openclaw.json written: stops an
   * embedding server a killed Gateway left behind, then rebuilds every agent's index
   * when the marker names another mode than the file compiles, or a rebuild did not
   * finish. Never rejects for a failed rebuild: the Gateway starts either way.
   */
  beforeSpawn() {
    const run = async () => {
      this.reconciling = true;
      try {
        await this.reconcile();
      } catch (error) {
        this.report(error);
      } finally {
        this.reconciling = false;
        // The owner's own operation goes on until its restart is done.
        if (this.running) this.progress({ phase: "starting" });
        else this.operation = null;
        this.changed();
      }
    };
    return (this.tail = this.tail.then(run, run));
  }
  report(error) {
    if (!this.closed)
      this.warn(
        `AgentPier could not rebuild the agents' memory indexes (${stable(error, "ERROR")}).`,
      );
  }
  async reconcile() {
    if (this.closed) return;
    // A new Gateway process: what the previous one's searches showed is void.
    this.health = this.checkedAt = null;
    const { paths } = this.supervisor;
    await this.reclaim(this.paths);
    const config = readJSON(paths.config, null);
    if (!config) return;
    const target = compiledSemantic(config) ? "local" : "keyword";
    const { journal } = this.read();
    const marker = this.marker();
    const current =
      marker.mode === target &&
      (target === "keyword" || marker.model === this.manifest.embeddingModel.sha256);
    // The one place the model's bytes are hashed while the setting is on; changed
    // bytes are handled like a failed rebuild below.
    const intact =
      target !== "local" || (await this.assets.verifyModel(this.root, this.manifest));
    if (current && !journal && intact) return this.settle(target);
    // No index yet (no agent with memory): nothing to rebuild, the marker follows.
    if (!indexedAgents(config).length) {
      this.mark(target);
      this.update({ journal: null });
      return this.settle(target);
    }
    try {
      if (!intact) throw failure("EMBEDDING_MODEL_CHANGED");
      await this.rebuildFor(target);
    } catch (error) {
      if (this.closed) throw error;
      if (target !== "local") {
        // Kept in the journal: the next start rebuilds again.
        this.update({
          failure: { code: stable(error, "MEMORY_INDEX_FAILED"), at: this.now() },
        });
        throw error;
      }
      // Back to keyword search: the setting goes off with the reason, the file this
      // start spawns with is rewritten and every index rebuilt for it.
      this.update({
        enabled: false,
        failure: { code: stable(error, "MEMORY_INDEX_FAILED"), at: this.now() },
      });
      writePrivate(paths.config, withoutSemanticMemory(readJSON(paths.config, null)));
      await this.rebuildFor("keyword");
      return this.settle("keyword");
    }
    await this.settle(target);
  }
  async rebuildFor(target) {
    const { paths, runtime } = this.supervisor;
    this.update({ journal: { target, since: this.now() } });
    this.progress({ phase: "indexing", target, done: 0, total: 0 });
    try {
      await this.rebuild({
        runtime,
        paths,
        signal: this.abort.signal,
        semantic: target === "local",
        onProgress: ({ done, total }) =>
          this.progress({ phase: "indexing", target, done, total }),
      });
    } finally {
      // The rebuild's own embedding server ends with its command; a killed one stays.
      await this.reclaim(this.paths);
    }
    this.mark(target);
    this.update({ journal: null });
  }
  // Once the indexes match the start: a model no setting uses any more is removed
  // (a partial download stays for the next attempt).
  async settle(target) {
    if (target === "keyword" && !this.read().enabled && !this.operation?.download)
      await this.assets
        .removeModel(this.root, this.manifest, { partial: false })
        .catch(() => {});
  }
  progress(step) {
    this.operation = { ...this.operation, ...step };
    this.changed();
  }
  /**
   * `{ available, reason, enabled, state, progress, failure, pending, revision,
   * model }` for the owner: `state` is "off", "downloading", "rebuilding", "on",
   * "degraded" (on, but keyword search is answering: `degraded.code`) or "failed"
   * (off, with `failure.code`). `pending`: the setting is on and the indexes
   * are rebuilt with the next start of the agent service.
   */
  status() {
    const state = this.read();
    const reason =
      this.unusable(this.supervisor.runtime, { assets: false }) ||
      (this.supervisor.runtime ? null : "SERVICE_STOPPED");
    const operation = this.operation;
    const marker = this.marker();
    const on = state.enabled && marker.mode === "local";
    let view = state.enabled ? "on" : state.failure ? "failed" : "off";
    let progress = null;
    // Not working although it is on: an asset is gone, or a search said so.
    const degraded = on && !operation ? this.degraded() : null;
    if (degraded) view = "degraded";
    if (operation?.phase === "downloading") {
      view = "downloading";
      progress = { received: operation.received || 0, total: operation.total || 0 };
    } else if (operation) {
      view = "rebuilding";
      progress = {
        target: operation.target,
        phase: operation.phase,
        done: operation.done || 0,
        total: operation.total || 0,
      };
    }
    const { id, size, termsUrl } = this.manifest.embeddingModel;
    return {
      available: !reason,
      ...(reason && { reason }),
      enabled: state.enabled,
      state: view,
      progress,
      failure: state.enabled ? null : state.failure,
      ...(degraded && { degraded }),
      pending: view === "on" && !on,
      revision: state.revision,
      model: { id, size, termsUrl },
    };
  }
  busy() {
    return !!this.operation || !!this.reconciling;
  }
  // Why local embeddings do not answer although the indexes are theirs, or null.
  degraded() {
    const missing = this.unusable(this.supervisor.runtime);
    if (!missing) return this.health;
    // Why a repair could not install it again says more than that it is missing.
    const { failure: last } = this.read();
    return { code: last?.code.startsWith("EMBEDDING_") ? last.code : missing };
  }
  /**
   * What a memory search of the running Gateway answered with (`details` of
   * OpenClaw's memory_search result). "none" while the setting is on means the
   * embeddings did not answer; "local" with hits means they did. A search without
   * hits proves nothing: an empty index is answered without an embedding.
   */
  observe(details) {
    if (!this.read().enabled || this.marker().mode !== "local" || this.busy()) return;
    const before = this.health;
    if (details?.provider === "none")
      this.health ||= { code: "EMBEDDINGS_UNAVAILABLE", at: this.now() };
    else if (details?.provider === "local" && details.results?.length) this.health = null;
    else return;
    if (before !== this.health) this.changed();
  }
  /**
   * Asks the running Gateway once whether embeddings answer, through `probe()` (one
   * search without hits per agent with memory; resolves the answers' `details`).
   * At most once per `everyMs`, and never while it is off or an operation runs. The
   * first check of a Gateway process may start the embedding server; later ones
   * follow an agent's own search, when it runs anyway.
   */
  async check(probe, { everyMs = 0 } = {}) {
    if (!this.read().enabled || this.marker().mode !== "local" || this.busy()) return;
    if (this.checking || this.degraded()) return;
    if (this.checkedAt !== null && this.now() - this.checkedAt < everyMs) return;
    this.checking = true;
    this.checkedAt = this.now();
    try {
      for (const details of await probe()) this.observe(details);
    } catch {
      // No answer is no evidence either way.
    } finally {
      this.checking = false;
    }
  }
  /**
   * The owner's switch. Refuses (409, a stable `code`) a stale `revision`, a switch
   * while an operation runs, and switching on where it cannot run or without the
   * model terms accepted. Answers the status at once; the operation goes on in the
   * background and reports through `changed()`.
   */
  set({ enabled, revision, acceptTerms, repair = false } = {}) {
    if (typeof enabled !== "boolean" || !Number.isInteger(revision))
      throw failure("INVALID", 400);
    const state = this.read();
    if (revision !== state.revision) throw failure("CONFLICT");
    if (this.busy()) throw failure("OPERATION_RUNNING");
    // "Repair": while it is on, installs the assets again and rebuilds.
    repair = repair === true && enabled && state.enabled;
    if (enabled === state.enabled && !repair) return this.status();
    if (enabled) {
      const { reason } = this.status();
      if (reason) throw failure(reason);
      if (acceptTerms !== true && !repair) throw failure("TERMS_REQUIRED", 400);
    }
    const target = enabled ? "local" : "keyword";
    this.operation = { target, phase: enabled ? "downloading" : "stopping" };
    this.write({
      ...state,
      revision: state.revision + 1,
      failure: null,
      intent: { target, since: this.now() },
    });
    this.running = (enabled ? this.switchOn({ repair }) : this.switchOff())
      .catch((error) => {
        // AgentPier's shutdown: the next start recovers (recover()).
        if (this.closed) return;
        const refused = error?.status === 409 && error?.key === "active";
        const code = refused
          ? "SERVICE_BUSY"
          : stable(error, enabled ? "ENABLE_FAILED" : "DISABLE_FAILED");
        // A restart that was refused leaves the previous setting in force (a refused
        // repair leaves it on, as degraded as before). After any other failure the
        // saved setting stands: the next start completes it, or falls back to
        // keyword search when an asset could not be installed again.
        this.update({
          ...(refused && !repair && { enabled: !enabled }),
          failure: { code, at: this.now() },
        });
      })
      .finally(() => {
        this.operation = this.running = null;
        if (this.closed) return;
        this.update({ intent: null });
      });
    return this.status();
  }
  async switchOn({ repair = false } = {}) {
    const signal = this.abort.signal;
    const onProgress = ({ received, total }) =>
      this.progress({ phase: "downloading", download: true, received, total });
    const options = { root: this.root, manifest: this.manifest, signal };
    if (repair) {
      // The marker stops naming this model, so the start rebuilds every index: for
      // local embeddings, or for keyword search should an asset stay missing. The
      // server is installed anew, which runs it once and names a missing library.
      writePrivate(path.join(this.supervisor.paths.state, markerFile), {
        mode: "local",
        model: "repair",
      });
      await this.assets.removeServer(this.root, this.manifest, this.host);
    }
    await this.assets.ensureServer({ ...options, ...this.host });
    await this.assets.ensureModel({ ...options, onProgress });
    // A model file from an earlier time is trusted only with its bytes checked.
    if (!(await this.assets.verifyModel(this.root, this.manifest))) {
      await this.assets.removeModel(this.root, this.manifest);
      await this.assets.ensureModel({ ...options, onProgress });
    }
    this.update({ enabled: true });
    this.progress({ phase: "stopping", download: false });
    // The start compiles local embeddings and rebuilds the indexes (beforeSpawn).
    await this.restart();
  }
  async switchOff() {
    this.update({ enabled: false });
    this.progress({ phase: "stopping" });
    await this.restart();
  }
  /** Resolves once no operation and no rebuild runs; for tests and shutdown. */
  async idle() {
    for (;;) {
      const { tail, running } = this;
      await Promise.allSettled([tail, running]);
      if (tail === this.tail && running === this.running) return;
    }
  }
  /** AgentPier's shutdown: stops a download or rebuild; the next start recovers. */
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.idle();
  }
  /** After the Gateway stopped for good: an embedding server it left behind ends. */
  retire() {
    return this.reclaim(this.paths).catch(() => false);
  }
}
