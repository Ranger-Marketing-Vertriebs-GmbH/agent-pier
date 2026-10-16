// Whether a session's run is shortening its history right now (OpenClaw 2026.10.3,
// recorded by tests/integration/assistant-compaction-contract.test.js):
// - before a run (runSessionCompactionIfNeeded): run_status `memory_flushing` for the
//   pre-compaction memory flush, `preparing_context` when the flush ends and the
//   compaction model call follows, then `preparing_workspace` for the run itself;
// - inside a run: the `compaction` stream, phase `start`, then `end` (`willRetry`
//   keeps it going).
// A run that ends or fails ends its compaction too. The finished compaction is a
// `kind: "compaction"` marker in chat.history (publicMessages).
const maxMs = 60 * 60000;

/** The session's compaction ({ runId, stage }) after one Gateway `agent` event. */
export function nextCompaction(current, payload) {
  const phase = payload?.data?.phase;
  const runId = payload?.runId;
  if (payload?.stream === "run_status") {
    if (typeof runId !== "string") return null;
    if (phase === "memory_flushing") return { runId, stage: "flushing" };
    if (
      phase === "preparing_context" &&
      current?.stage === "flushing" &&
      current.runId === runId
    )
      return { runId, stage: "compacting" };
    return null;
  }
  if (payload?.stream === "compaction") {
    if (phase === "start")
      return typeof runId === "string" ? { runId, stage: "compacting" } : current;
    if (phase === "end") return payload.data.willRetry === true ? current : null;
    return current;
  }
  if (payload?.stream === "lifecycle" && ["end", "error"].includes(phase)) return null;
  return current;
}

/** Sessions whose run summarises its conversation, from Gateway `agent` events. */
export class Compactions {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.running = new Map();
  }
  /** True when the event starts or ends a compaction of its session. */
  observe(payload) {
    const key = payload?.sessionKey;
    if (typeof key !== "string") return false;
    const was = this.active(key);
    const current = this.running.get(key) || null;
    const next = nextCompaction(current, payload);
    if (!next) this.running.delete(key);
    else if (next !== current)
      this.running.set(key, { ...next, at: current?.at ?? this.now() });
    return was !== this.active(key);
  }
  active(sessionKey) {
    const entry = this.running.get(sessionKey);
    if (entry && this.now() - entry.at > maxMs) this.running.delete(sessionKey);
    return this.running.has(sessionKey);
  }
  clear() {
    this.running.clear();
  }
}
