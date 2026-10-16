// OpenClaw 2026.10.3 runs its pre-compaction memory flush as a separate run in a
// detached internal session of the agent (resolveInternalSessionEffectsIdentity),
// so no AgentPier attempt is bound to the key its write tool reports. The source
// run announces the flush on its own session: run_status `memory_flushing` before
// it, any other phase after it (agent-runner-memory: runMemoryFlushIfNeeded).
const flushSession = /^agent:([^:]{1,200}):internal-session-effects:[A-Za-z0-9-]{1,200}$/;
// The flush's only writer appends to memory/<date>.md (wrapToolMemoryFlushAppendOnlyWrite).
export const flushTarget = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
// A flush runs one bounded model turn; a report older than this is not trusted.
const flushMaxMs = 10 * 60000;

/** The agent id of a memory flush session key, or null for every other key. */
export const flushSessionAgent = (sessionKey) =>
  (typeof sessionKey === "string" && sessionKey.match(flushSession)?.[1]) || null;

/** Source sessions whose run is in OpenClaw's memory flush phase right now. */
export class MemoryFlushes {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.running = new Map();
  }
  /** Takes every Gateway `agent` event; only run phases matter. */
  observe(payload) {
    const key = payload?.sessionKey;
    if (typeof key !== "string") return;
    const phase = payload.data?.phase;
    if (payload.stream === "run_status" && phase === "memory_flushing") {
      if (typeof payload.runId === "string")
        this.running.set(key, { sessionKey: key, runId: payload.runId, at: this.now() });
    } else if (
      payload.stream === "run_status" ||
      (payload.stream === "lifecycle" && ["end", "error"].includes(phase))
    )
      this.running.delete(key);
  }
  clear() {
    this.running.clear();
  }
  active() {
    const now = this.now();
    for (const [key, flush] of this.running)
      if (now - flush.at > flushMaxMs) this.running.delete(key);
    return [...this.running.values()];
  }
}
