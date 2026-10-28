// Terminal notices: the latest Claude approval per session that left chat for
// Claude's own dialog. A notice describes a moment, not a state; it fades after
// `terminalNoticeMs` on its own, and a timer reports that fade like every other
// change, so a pushed request list drops it without anyone reading again.

export const terminalNoticeMs = 10 * 60 * 1000;

export class RequestNotices {
  /** `onChange(sessionId)` hears every notice that appears, is cleared or fades. */
  constructor({
    onChange = () => {},
    ttlMs = terminalNoticeMs,
    timers = { setTimeout, clearTimeout },
  } = {}) {
    Object.assign(this, { onChange, ttlMs, timers });
    this.records = new Map();
    this.expiries = new Map();
  }
  /** Claude now shows its own approval dialog; chat must not just go blank. */
  terminal(entry) {
    if (
      entry?.source !== "claude" ||
      entry.kind !== "permission" ||
      entry.presentation ||
      entry.local
    )
      return;
    const { sessionId } = entry;
    this.records.set(sessionId, { id: entry.id, reason: "terminal", at: Date.now() });
    this.timers.clearTimeout(this.expiries.get(sessionId));
    const timer = this.timers.setTimeout(() => {
      this.expiries.delete(sessionId);
      this.clear(sessionId);
    }, this.ttlMs);
    timer?.unref?.();
    this.expiries.set(sessionId, timer);
    this.changed(sessionId);
  }
  /** Chat moved on, a newer request came or the session ended: the notice is history. */
  clear(sessionId) {
    this.timers.clearTimeout(this.expiries.get(sessionId));
    this.expiries.delete(sessionId);
    if (this.records.delete(sessionId)) this.changed(sessionId);
  }
  /** The session's notice as `{id, reason}`, or undefined once it faded. */
  get(sessionId) {
    const notice = this.records.get(sessionId);
    if (!notice) return undefined;
    if (Date.now() - notice.at >= this.ttlMs) {
      this.clear(sessionId);
      return undefined;
    }
    return { id: notice.id, reason: notice.reason };
  }
  close() {
    for (const timer of this.expiries.values()) this.timers.clearTimeout(timer);
    this.expiries.clear();
  }
  changed(sessionId) {
    try {
      this.onChange(sessionId);
    } catch {
      // A change hint is advisory; the next read still sees the notice.
    }
  }
}
