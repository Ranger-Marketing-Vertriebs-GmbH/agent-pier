import fs from "node:fs";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";

// How often a pending restart checks again whether nothing is busy any more.
export const pendingRestartRetryMs = 15000;
// Reasons a save names; the UI shows each one (assistants.js pendingRestartReasons).
export const pendingRestartReasons = [
  "webTools",
  "webSearch",
  "pdfModel",
  "connection",
  "telegram",
];

/**
 * Whether a runtime update must wait: a maintenance restart runs, or a pending restart
 * is trying (its busy check runs outside maintenance, before `changing` is set).
 */
export const updateBlocked = (synchronization, pending) =>
  !!(synchronization?.changing || pending?.running);

const valid = (state) =>
  state &&
  typeof state.since === "number" &&
  Array.isArray(state.reasons) &&
  Array.isArray(state.affected?.agents);

/**
 * A Gateway restart a saved change still needs (provider keys, a search provider or
 * key, the PDF model, an agent's own Telegram bot, a browser installed after the
 * start). The change is saved at once; the restart is recorded here (persisted in
 * `<runtime>/pending-restart.json`), further changes join it, and it runs by itself
 * as soon as nothing is busy (AssistantProviderSynchronization.restartGateway refuses
 * while work runs). The owner can run it at once with `restartNow` instead, which
 * interrupts running agent work. Any later Gateway start compiles every saved change,
 * so a start of another Gateway generation ends it too, also after an AgentPier
 * restart.
 */
export class PendingRestart {
  constructor({
    assistants,
    synchronization,
    retryMs = pendingRestartRetryMs,
    warn = console.warn,
  }) {
    Object.assign(this, { assistants, synchronization, retryMs, warn });
    this.version = 0;
    this.state = this.load();
    this.onStatus = (status) => {
      if (status.availability === "ready") this.settle();
    };
    assistants.runtime.on?.("status", this.onStatus);
    if (this.state) this.schedule(this.retryMs);
  }
  get file() {
    const root = this.assistants.runtime.paths?.root;
    return root ? path.join(root, "pending-restart.json") : null;
  }
  load() {
    try {
      const state = this.file && readJSON(this.file, null);
      return valid(state) ? state : null;
    } catch {
      return null;
    }
  }
  persist() {
    if (!this.file) return;
    if (this.state) writePrivate(this.file, this.state);
    else fs.rmSync(this.file, { force: true });
  }
  /**
   * `{ since, reasons, affected, waitingFor, failed, running }` while a restart is
   * pending, else null. `failed`: the last try failed for another reason than busy work.
   */
  status() {
    if (!this.state) return null;
    const { since, reasons, affected, waitingFor = [], failed = false } = this.state;
    return { since, reasons, affected, waitingFor, failed, running: !!this.restarting };
  }
  /**
   * Records that the running Gateway needs a restart for `reason`, interrupting
   * `affected` (`{ agents: [{ id, name }], teamMembers }`). A stopped Gateway
   * compiles the change at its next start, so nothing is recorded then; a starting
   * one may have compiled before the save, so it counts as running. Resolves
   * whether a restart is pending.
   */
  request(reason, affected = { agents: [], teamMembers: 0 }) {
    const runtime = this.assistants.runtime;
    const availability = runtime.status?.().availability;
    if (availability ? availability === "disabled" : !runtime.client?.ready) return false;
    const state = this.state || {
      since: Date.now(),
      reasons: [],
      affected: { agents: [], teamMembers: 0 },
      generationId: runtime.generationId || null,
    };
    if (!state.reasons.includes(reason)) state.reasons.push(reason);
    for (const agent of affected.agents || [])
      if (!state.affected.agents.some((known) => known.id === agent.id))
        state.affected.agents.push({ id: agent.id, name: agent.name });
    state.affected.teamMembers = Math.max(
      state.affected.teamMembers || 0,
      affected.teamMembers || 0,
    );
    this.state = state;
    this.version++;
    this.persist();
    this.assistants.changed?.();
    // Straight away when nothing is busy; the save itself does not wait for it.
    this.schedule(0);
    return true;
  }
  /** A Gateway of another generation is ready: it compiled every saved change. */
  settle() {
    const runtime = this.assistants.runtime;
    if (!this.state || this.running) return;
    if (runtime.generationId && runtime.generationId !== this.state.generationId)
      this.clear();
  }
  clear() {
    this.state = null;
    clearTimeout(this.timer);
    this.persist();
    this.assistants.changed?.();
  }
  schedule(ms) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.attempt().catch(() => {});
    }, ms);
    this.timer.unref?.();
  }
  /** The owner's "Restart now": runs it at once, also while agents are busy. */
  restartNow() {
    return this.attempt({ force: true });
  }
  /** Records what the restart waits for, or that the last try failed. */
  wait(waitingFor, failed = false) {
    if (!this.state) return;
    this.state.waitingFor = waitingFor;
    this.state.failed = failed;
    this.persist();
    this.assistants.changed?.();
    this.schedule(this.retryMs);
  }
  async attempt({ force = false } = {}) {
    // A ready event this instance missed must not cause a needless restart.
    this.settle();
    if (!this.state) return null;
    if (this.running) {
      if (!force) return this.running;
      // The owner's restart never just joins an automatic try that may stop at busy
      // work: it runs after it, unless that one restarted.
      await this.running.catch(() => {});
      return this.attempt({ force });
    }
    // A stopped or starting Gateway compiles the changes when it starts.
    if (!this.assistants.runtime.client?.ready) {
      this.schedule(this.retryMs);
      return null;
    }
    const version = this.version;
    this.running = (async () => {
      try {
        // Checked outside maintenance: a busy host never enters it (admission, cron,
        // Telegram) just to find out. restartGateway checks again inside.
        if (!force) {
          const blockers = await this.synchronization.busy();
          if (blockers.length) {
            this.wait(blockers);
            return null;
          }
        }
        this.restarting = true;
        this.assistants.changed?.();
        await this.synchronization.restartGateway(() => null, { force });
        // A change saved during the restart may have been compiled too late.
        if (this.version === version) this.clear();
        else {
          this.state.generationId = this.assistants.runtime.generationId || null;
          this.wait([]);
        }
        return { restarted: true };
      } catch (error) {
        // A refusal (busy work, an update or other maintenance) is waited out.
        const refused = error?.status === 409 && error?.key === "active";
        const blockers = error?.blockers || (refused ? ["active"] : null);
        if (!blockers)
          this.warn(
            `A pending agent service restart failed (${error?.code || error?.key || "ERROR"}); retrying.`,
          );
        this.wait(blockers || [], !blockers);
        throw error;
      } finally {
        this.running = null;
        const restarted = this.restarting;
        this.restarting = false;
        if (restarted) this.assistants.changed?.();
      }
    })();
    return this.running;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.assistants.runtime.off?.("status", this.onStatus);
  }
}
