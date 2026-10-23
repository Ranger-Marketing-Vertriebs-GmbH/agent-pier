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
  /** `{ since, reasons, affected, waitingFor }` while a restart is pending, else null. */
  status() {
    if (!this.state) return null;
    const { since, reasons, affected, waitingFor = [] } = this.state;
    return { since, reasons, affected, waitingFor, running: !!this.running };
  }
  /**
   * Records that the running Gateway needs a restart for `reason`, interrupting
   * `affected` (`{ agents: [{ id, name }], teamMembers }`). A stopped Gateway
   * compiles the change at its next start, so nothing is recorded then. Resolves
   * whether a restart is pending.
   */
  request(reason, affected = { agents: [], teamMembers: 0 }) {
    const runtime = this.assistants.runtime;
    if (!runtime.client?.ready) return false;
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
  async attempt({ force = false } = {}) {
    if (!this.state) return null;
    if (this.running) return this.running;
    // A stopped or starting Gateway compiles the changes when it starts.
    if (!this.assistants.runtime.client?.ready) {
      this.schedule(this.retryMs);
      return null;
    }
    const version = this.version;
    this.running = (async () => {
      try {
        await this.synchronization.restartGateway(() => null, { force });
        // A change saved during the restart may have been compiled too late.
        if (this.version === version) this.clear();
        else {
          this.state.generationId = this.assistants.runtime.generationId || null;
          this.state.waitingFor = [];
          this.persist();
          this.schedule(this.retryMs);
        }
        return { restarted: true };
      } catch (error) {
        if (this.state) {
          this.state.waitingFor = error?.blockers || [error?.key || "unavailable"];
          this.persist();
          this.assistants.changed?.();
          this.schedule(this.retryMs);
        }
        throw error;
      } finally {
        this.running = null;
      }
    })();
    this.assistants.changed?.();
    return this.running;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.assistants.runtime.off?.("status", this.onStatus);
  }
}
