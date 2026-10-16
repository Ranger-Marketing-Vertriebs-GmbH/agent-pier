// OpenClaw 2026.10.3 runs its pre-compaction memory flush as a separate run in a
// detached internal session of the agent (resolveInternalSessionEffectsIdentity),
// so no AgentPier attempt is bound to the key its write tool reports. The source
// run announces the flush on its own session: run_status `memory_flushing` before
// it, any other phase after it (agent-runner-memory: runMemoryFlushIfNeeded).
// Any internal key is routed to the flush policy (and refused unless it is one);
// a flush's own key is `<prefix><runId>-<sha16>` with the run id the hook reports.
const flushSession = /^agent:([^:]{1,200}):internal-session-effects:[A-Za-z0-9-]{1,200}$/;
const flushRunKey =
  /^agent:[^:]{1,200}:internal-session-effects:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]{16}$/;
/** The flush run id a flush session key names, or null. */
export const flushRunOf = (sessionKey) => sessionKey.match(flushRunKey)?.[1] || null;
// memory-core names the day note in the Gateway's user timezone (resolveCronStyleNow:
// agents.defaults.userTimezone, else the host's). A flush writes today's note; just
// after midnight the run may still hold yesterday's.
export function flushDates(now, timeZone) {
  const format = (zone) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  let formatter;
  try {
    formatter = format(timeZone);
  } catch {
    formatter = format(undefined);
  }
  const day = (ms) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(ms).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  // Calendar days, not 24 h steps: a DST change makes one day 23 or 25 hours long.
  const days = [];
  for (const hours of [0, 12, 24, 36]) {
    const date = day(now - hours * 3600000);
    if (!days.includes(date)) days.push(date);
  }
  return days.slice(0, 2).map((d) => `memory/${d}.md`);
}
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
  /**
   * Pins a flush to the first internal session that writes for it: true when
   * `sessionKey` is (or now becomes) that session, false for any other.
   */
  pin(flush, sessionKey) {
    const entry = this.running.get(flush.sessionKey);
    if (!entry || entry.runId !== flush.runId) return false;
    entry.writer ??= sessionKey;
    return entry.writer === sessionKey;
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
