import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export const talkLimits = Object.freeze({
  // One talk session lasts at most this long; the browser starts a new one after.
  maxMs: 30 * 60 * 1000,
  // Talk sessions a login may start within the window.
  starts: 10,
  windowMs: 10 * 60 * 1000,
});

/**
 * The owner's talk sessions (AGENTPIER-291): hands-free turns in an agent chat, each
 * spoken turn a dictation (dictation-service.js) and each reply read aloud
 * (speech-output.js). One session per login session (`holder`): a newer one replaces
 * the older, in another tab too. A session ends when the browser stops it, its page is
 * hidden (the browser stops it then), after `maxMs`, or when AgentPier shuts down.
 * Emits `ended` with `(holder, reason)` so the talk dictation of that login stops.
 */
export class TalkSessions extends EventEmitter {
  constructor({ audit, clock = Date, limits = {} } = {}) {
    super();
    Object.assign(this, { audit, clock });
    this.limits = { ...talkLimits, ...limits };
    this.sessions = new Map();
    this.starts = new Map();
  }
  /** The running session of `holder`, or null; an expired one ends here. */
  current(holder) {
    const session = this.sessions.get(holder);
    if (!session) return null;
    if (this.clock.now() >= session.expiresAt) {
      this.end(holder, "limit");
      return null;
    }
    return session;
  }
  /** Starts a session for `holder` and conversation `conversationId`. */
  start(holder, conversationId) {
    const now = this.clock.now();
    const recent = (this.starts.get(holder) || []).filter(
      (at) => now - at < this.limits.windowMs,
    );
    if (recent.length >= this.limits.starts) return { refused: "rateLimited" };
    recent.push(now);
    this.starts.set(holder, recent);
    if (this.sessions.has(holder)) this.end(holder, "replaced");
    const session = {
      id: randomBytes(18).toString("base64url"),
      conversationId,
      startedAt: now,
      expiresAt: now + this.limits.maxMs,
    };
    session.timer = setTimeout(() => this.end(holder, "limit"), this.limits.maxMs);
    session.timer.unref?.();
    this.sessions.set(holder, session);
    return { session: publicSession(session) };
  }
  /** Ends the session of `holder` if `id` names it (any session without `id`). */
  stop(holder, id) {
    const session = this.sessions.get(holder);
    if (!session || (id && session.id !== id)) return false;
    this.end(holder, "stopped");
    return true;
  }
  end(holder, reason) {
    const session = this.sessions.get(holder);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(holder);
    try {
      this.audit?.append({
        action: "speech.completed",
        resourceType: "speech",
        source: "user",
        outcome: "success",
        details: {
          kind: "talk",
          seconds: Math.round((this.clock.now() - session.startedAt) / 1000),
        },
      });
    } catch {}
    this.emit("ended", holder, reason);
  }
  close() {
    for (const holder of [...this.sessions.keys()]) this.end(holder, "closed");
  }
}

/** What the browser learns of its session: never another login's. */
export const publicSession = ({ id, conversationId, startedAt, expiresAt }) => ({
  id,
  conversationId,
  startedAt,
  expiresAt,
});
