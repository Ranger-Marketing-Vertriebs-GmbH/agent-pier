import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJSON } from "../../../../lib/storage.js";
import { durablePrivate } from "../../runtime-update-snapshot.js";

/*
 * OpenClaw's offline-only CLI commands and the maintenance window they need
 * (docs/assistant-gateway.md, Offline-only commands). Since 2026.10.10 (upstream
 * #168135 and #168471) `openclaw memory forget`, `mcp login` (with `--code` too) and
 * `mcp logout` refuse while a Gateway owns the state ("requires exclusive offline
 * state ownership"). AgentPier then runs them while its own Gateway is stopped:
 *
 * - at every Gateway start, before the spawn (`drain`, the supervisor's beforeSpawn),
 *   and directly whenever no Gateway process runs;
 * - a deleted chat's forget is queued durably (`offline-commands.json`) and asks for
 *   a restart soon after a short debounce (`request`: the pending restart, which waits
 *   until no agent is busy), so several deletions share one window; one still waiting
 *   after 15 minutes, or when dreaming's nightly sweep is near, restarts at once
 *   (`force`), busy agents or not;
 * - an owner's MCP sign-in or sign-out (`run`) opens a window at once: the supervisor
 *   stops the Gateway (running turns drain as in any restart), the command runs with
 *   every queued forget, and the Gateway starts again in the background.
 *
 * Older runtimes (the 2026.10.9 rollback target) run every command directly, as before.
 */
export const offlineGuardVersion = "2026.10.10";
export const queueName = "offline-commands.json";
// A refusal while the stopped Gateway's lock is still being released.
const ownedLine = /exclusive offline state ownership|Cannot admit .* in state root/;
export const stateOwned = (stderr) => ownedLine.test(String(stderr ?? ""));

const parts = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return match ? match.slice(1).map(Number) : null;
};
/** Whether OpenClaw `version` refuses the offline-only commands beside a Gateway. */
export function offlineOnly(version) {
  const have = parts(version);
  // An unknown runtime counts as guarded: a window works on every version.
  if (!have) return true;
  const need = parts(offlineGuardVersion);
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

export class OfflineCommands {
  /**
   * - `supervisor`: the RuntimeSupervisor (`runtime`, `child`, `starting`, `paths`,
   *   `stop`, `start`, `setState`, `closed`).
   * - `forget({ agent, sessions })`: runs `openclaw memory forget` (rejects with
   *   `stateOwned` when OpenClaw still saw an owner).
   * - `request(reason)`: asks for a restart soon; false when none was recorded.
   * - `busy()`: whether a window must not start now (maintenance, a restart).
   * - `force()`: runs the pending restart at once, also beside busy agents.
   * - `urgent()`: whether dreaming's nightly sweep starts soon.
   */
  constructor({
    supervisor,
    forget,
    request = () => false,
    busy = () => false,
    force = null,
    urgent = () => false,
    now = Date.now,
    deadlineMs = 15 * 60000,
    checkMs = 60000,
    debounceMs = 5000,
    retryMs = 60000,
    maxAttempts = 3,
    ownershipWaitMs = [250, 500, 1000, 2000, 4000],
    warn = console.warn,
  }) {
    Object.assign(this, {
      supervisor,
      forgetCommand: forget,
      request,
      busy,
      force,
      urgent,
      now,
      deadlineMs,
      checkMs,
      debounceMs,
      retryMs,
      maxAttempts,
      ownershipWaitMs,
      warn,
    });
    this.tail = Promise.resolve();
    this.restarting = null;
    this.marks = 0;
  }
  get file() {
    const root = this.supervisor.paths?.root;
    return root ? path.join(root, queueName) : null;
  }
  /** The queued forgets: `[{ agent, sessions, attempts, since }]`, one per agent. */
  queued() {
    try {
      const value = this.file && readJSON(this.file, null);
      return Array.isArray(value?.forgets) ? value.forgets : [];
    } catch {
      return [];
    }
  }
  save(forgets) {
    if (!this.file) return;
    if (forgets.length) durablePrivate(this.file, { forgets });
    else fs.rmSync(this.file, { force: true });
  }
  guarded() {
    return offlineOnly(this.supervisor.runtime?.version);
  }
  /** Whether a Gateway process runs (or still drains) now. */
  online() {
    const child = this.supervisor.child;
    return (!!child && child.exitCode === null && !child.signalCode) || this.launching();
  }
  // A start under way: its beforeSpawn drained the queue, its spawn follows.
  launching() {
    return !!this.supervisor.starting;
  }
  /** Whether an offline-only command needs a window now. */
  windowNeeded() {
    return this.guarded() && this.online();
  }
  /**
   * Queues the forget of `sessions` of runtime agent `agent` and runs it soon: at
   * once without a running guarded Gateway (resolved once it ran), else in the next
   * window (resolved once that is requested).
   */
  forget(agent, sessions) {
    const forgets = this.queued();
    const entry = forgets.find((e) => e.agent === agent);
    if (entry) entry.sessions = [...new Set([...entry.sessions, ...sessions])];
    else
      forgets.push({
        agent,
        sessions: [...new Set(sessions)],
        attempts: 0,
        since: this.now(),
      });
    this.save(forgets);
    return this.soon();
  }
  soon(ms = this.debounceMs) {
    if (this.closed) return Promise.resolve();
    if (!this.windowNeeded()) return this.drain();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ask().catch(() => {}), ms);
    this.timer.unref?.();
    return Promise.resolve();
  }
  /** Runs the debounced request now; for tests and shutdown-free contracts. */
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    await this.ask();
    await this.idle();
  }
  async ask() {
    this.timer = null;
    if (this.closed || !this.queued().length) return;
    if (!this.windowNeeded()) return this.drain();
    // The pending restart waits until nothing is busy; its start drains the queue.
    if (this.request("memoryForget")) return void this.watch();
    if (this.busy() || this.launching()) return void this.soon(this.retryMs);
    await this.locked(() => (this.windowNeeded() ? this.window(null) : this.forgets()));
  }
  /**
   * Runs `task` (an offline-only CLI call) where OpenClaw accepts it: directly on an
   * older runtime, under the queue's lock while no Gateway runs, else in a window.
   * Refuses with code RUNTIME_BUSY while maintenance or a restart is under way.
   */
  run(task) {
    if (!this.guarded()) return task();
    return this.locked(() => {
      if (!this.online()) return this.attempt(task);
      if (this.busy() || this.closed || this.launching())
        throw Object.assign(new Error("The agent service is busy."), {
          code: "RUNTIME_BUSY",
        });
      return this.window(task);
    });
  }
  /** Runs every queued forget; the supervisor calls it before each Gateway spawn. */
  drain() {
    return this.locked(() => this.forgets());
  }
  locked(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
  // Under the lock: stop, run, start again. The start is not awaited: it drains (and
  // its MCP logouts take their own locks), and the caller may hold such a lock. Until
  // the start, `windowOpen` refuses admitted calls at once (AssistantService.admit):
  // the caller may hold admission while the stop waits for turns that need it.
  async window(task) {
    this.mark(1);
    this.windowOpen = true;
    let outcome = {};
    try {
      await this.supervisor.stop();
      if (task) outcome.value = await this.attempt(task);
    } catch (error) {
      outcome = { error };
    }
    try {
      await this.forgets();
    } finally {
      this.windowOpen = false;
    }
    if (this.supervisor.closed) this.mark(-1);
    else
      this.restarting = this.supervisor
        .start({ automatic: true })
        .catch(() => {
          // The supervisor's own recovery retries the start (scheduleRestart).
        })
        .finally(() => {
          this.restarting = null;
          this.mark(-1);
        });
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
  /** `task` again while OpenClaw still sees the stopped Gateway's ownership. */
  async attempt(task) {
    for (let i = 0; ; i++) {
      try {
        return await task();
      } catch (error) {
        if (!error?.stateOwned || i >= this.ownershipWaitMs.length) throw error;
        await delay(this.ownershipWaitMs[i]);
      }
    }
  }
  async forgets() {
    const queue = this.queued();
    if (!queue.length) return;
    this.mark(1);
    try {
      for (const { agent, sessions } of queue) {
        try {
          await this.attempt(() => this.forgetCommand({ agent, sessions }));
          this.save(
            this.queued()
              .map((e) =>
                e.agent === agent
                  ? { ...e, sessions: e.sessions.filter((s) => !sessions.includes(s)) }
                  : e,
              )
              .filter((e) => e.sessions.length),
          );
        } catch (error) {
          this.save(
            this.queued().map((e) =>
              e.agent === agent ? { ...e, attempts: (e.attempts || 0) + 1 } : e,
            ),
          );
          this.warn(
            "AgentPier could not remove a deleted chat from dreaming:",
            error?.stateOwned ? "STATE_OWNED" : error?.code || "FAILED",
          );
        }
      }
    } finally {
      this.mark(-1);
    }
    // A failed forget asks for a few more windows, then waits for the next start.
    const failed = this.queued().filter((e) => e.attempts > 0);
    if (failed.some((e) => e.attempts < this.maxAttempts))
      this.later(this.retryMs * Math.max(...failed.map((e) => e.attempts)));
  }
  // Once a minute while forgets wait for the pending restart (`overdue`).
  watch() {
    if (this.watchTimer || this.closed || !this.force) return;
    this.watchTimer = setInterval(() => this.overdue().catch(() => {}), this.checkMs);
    this.watchTimer.unref?.();
  }
  /**
   * Forces the restart once the oldest forget with attempts left waited `deadlineMs`,
   * or dreaming's sweep is near: busy agents must not keep a deleted chat in
   * dreaming's copies for hours, nor let a sweep read it first.
   */
  async overdue() {
    const waiting = this.queued().filter((e) => (e.attempts || 0) < this.maxAttempts);
    if (this.closed || !waiting.length) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
      return;
    }
    const oldest = Math.min(...waiting.map((e) => e.since ?? 0));
    if (this.forcing || !this.windowNeeded()) return;
    if (this.now() - oldest < this.deadlineMs && !this.urgent()) return;
    this.forcing = true;
    try {
      await this.force();
    } finally {
      this.forcing = false;
    }
  }
  later(ms) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ask().catch(() => {}), ms);
    this.timer.unref?.();
  }
  // The runtime status says "maintenance" while a window or a drain runs.
  mark(step) {
    const before = this.marks > 0;
    this.marks = Math.max(0, this.marks + step);
    if (before !== this.marks > 0)
      this.supervisor.setState?.({ maintenanceWindow: this.marks > 0 });
  }
  /** Resolves once no command runs and a window's start has settled. */
  idle() {
    return Promise.allSettled([this.tail, this.restarting]).then(() => undefined);
  }
  close() {
    this.closed = true;
    clearInterval(this.watchTimer);
    clearTimeout(this.timer);
    this.timer = null;
    return this.idle();
  }
}
