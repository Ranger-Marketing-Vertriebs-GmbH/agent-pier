// One live socket's subscriptions (live-websocket.js). Every client frame is checked
// here before the hub sees it. Each topic the client asks for goes to the hub as is,
// known or not, so an unknown and a forbidden topic take the same path and answer
// alike. A reader that falls behind keeps only the newest frame per topic.
import { MAX_TOPIC_ID } from "./live-hub.js";

export const MAX_TOPICS = 64;
// Above this many buffered bytes, frames wait per topic (the newest one wins).
export const QUEUE_BYTES = 256 * 1024;
// Above this many, the reader is too slow: the socket closes with 1013.
export const CLOSE_BYTES = 2 * 1024 * 1024;
export const FLUSH_MS = 100;
// Presence ops one socket may send per minute; the notification service limits the
// person as the REST route does, this keeps one socket from flooding it.
export const PRESENCE_PER_MINUTE = 60;
// Sub and unsub frames one socket may send per minute (a token bucket that holds as
// many and refills evenly). An unsub of the last subscriber drops the topic instance
// and the next sub reads it again (a file topic also watches anew), so a client that
// loops would churn without end. A page load or a view change sends a few dozen. An
// unsub takes a token but is always honoured, since it only frees; a sub over the
// limit is refused like a full socket (`error` with code `limit`).
export const SUBS_PER_MINUTE = 600;
// A longer route names no view (push-presence.js) and is ignored.
export const MAX_ROUTE = 512;

const OPEN = 1;
const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The client frame as `{op, topic?, have?}` or `{op:"presence", route}`, or null when it is malformed. */
export function parseClientFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plainObject(frame)) return null;
  const { op, topic, have } = frame;
  if (op === "ping") return { op };
  if (op === "presence")
    return typeof frame.route === "string" ? { op, route: frame.route } : null;
  if (op !== "sub" && op !== "unsub") return null;
  if (typeof topic !== "string") return null;
  if (op === "unsub") return { op, topic };
  if (have !== undefined && !plainObject(have)) return null;
  return { op, topic, have };
}

export class LiveConnection {
  constructor({
    ws,
    hub,
    principal,
    timers = { setInterval, clearInterval },
    maxTopics = MAX_TOPICS,
    presence = null,
    now = Date.now,
  }) {
    Object.assign(this, { ws, hub, principal, timers, maxTopics, presence, now });
    this.presenceTimes = [];
    this.subTokens = SUBS_PER_MINUTE;
    this.subRefilledAt = this.now();
    // topic -> { unsubscribe }; a frame from a replaced entry is dropped.
    this.subscriptions = new Map();
    // topic -> the newest frame not yet written, while the reader is behind.
    this.pending = new Map();
    this.flushTimer = null;
    this.closed = false;
    // A closed hub ends the connection: no timer or subscription outlives it.
    this.offHub = hub.onClose?.(() => this.close(1012)) || null;
  }
  /** Handles one client text frame; false when the socket must close with 1008. */
  receive(text) {
    if (this.closed) return true;
    const frame = parseClientFrame(text);
    if (!frame) return false;
    if (frame.op === "ping") this.reply({ type: "pong" });
    else if (frame.op === "presence") this.reportPresence(frame.route);
    else if (frame.op === "unsub") {
      this.takeSubToken();
      this.unsubscribe(frame.topic);
    } else if (this.takeSubToken()) this.subscribe(frame.topic, frame.have);
    else {
      // The client takes a refused topic as not live and never unsubscribes it.
      this.unsubscribe(frame.topic);
      this.refuse(frame.topic);
    }
    return true;
  }
  /** Takes one sub/unsub token; false when the bucket is empty. */
  takeSubToken() {
    const at = this.now();
    const refill = ((at - this.subRefilledAt) * SUBS_PER_MINUTE) / 60000;
    this.subTokens = Math.min(SUBS_PER_MINUTE, this.subTokens + Math.max(0, refill));
    this.subRefilledAt = at;
    if (this.subTokens < 1) return false;
    this.subTokens -= 1;
    return true;
  }
  refuse(topic) {
    this.reply({ type: "error", topic: topic.slice(0, MAX_TOPIC_ID), code: "limit" });
  }
  /**
   * A visible tab names its view, as POST /notifications/presence does. The owner
   * reports without a scope, a user in her own (me-notifications.js); a socket never
   * reports in another person's scope. Over-long routes and excess ops are ignored.
   */
  reportPresence(route) {
    if (!this.presence || route.length > MAX_ROUTE) return;
    const at = this.now();
    this.presenceTimes = this.presenceTimes.filter((time) => at - time < 60000);
    if (this.presenceTimes.length >= PRESENCE_PER_MINUTE) return;
    this.presenceTimes.push(at);
    const { principal } = this;
    if (principal.role === "owner") this.presence(route);
    else if (principal.role === "user" && principal.userId)
      this.presence(route, { userId: principal.userId });
  }
  subscribe(topic, have) {
    const held = this.subscriptions.get(topic);
    if (!held && this.subscriptions.size >= this.maxTopics) return this.refuse(topic);
    // A frame queued for the earlier subscription answers what it held, not `have`.
    this.pending.delete(topic);
    const entry = { unsubscribe: () => {} };
    this.subscriptions.set(topic, entry);
    // Subscribe first, then drop the earlier subscription, so a shared instance
    // stays and answers from its settled value.
    entry.unsubscribe = this.hub.subscribe(
      this.principal,
      topic,
      have,
      (frame) => this.deliver(topic, entry, frame),
      {
        // A frame held back from before an access change is never written.
        discard: () => {
          if (this.subscriptions.get(topic) === entry) this.pending.delete(topic);
        },
      },
    );
    held?.unsubscribe();
  }
  unsubscribe(topic) {
    const held = this.subscriptions.get(topic);
    this.subscriptions.delete(topic);
    this.pending.delete(topic);
    held?.unsubscribe();
  }
  /**
   * A row delta whose predecessor still waits cannot replace it: the client lacks the
   * base. The topic subscribes again without `have`, which answers a snapshot.
   */
  resync(topic) {
    if (this.closed || this.hub.closed || !this.subscriptions.has(topic)) return;
    this.subscribe(topic, undefined);
  }
  deliver(topic, entry, frame) {
    if (this.closed || this.subscriptions.get(topic) !== entry) return;
    if (frame.type === "revoked") this.subscriptions.delete(topic);
    if (this.tooSlow()) return;
    if (this.pending.size || this.ws.bufferedAmount > QUEUE_BYTES) {
      // Outside the hub's send loop, which must not see its subscribers change.
      if (frame.type === "delta" && this.pending.has(topic))
        return queueMicrotask(() => this.resync(topic));
      this.pending.delete(topic);
      this.pending.set(topic, frame);
      this.schedule();
      return;
    }
    this.write(frame);
  }
  /** A frame outside any topic order (hello, pong, limit). */
  reply(frame) {
    if (this.closed || this.tooSlow()) return;
    this.write(frame);
  }
  write(frame) {
    if (this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify(frame));
    if (this.ws.bufferedAmount > QUEUE_BYTES) this.schedule();
  }
  tooSlow() {
    if (this.ws.bufferedAmount <= CLOSE_BYTES) return false;
    this.close(1013);
    return true;
  }
  schedule() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = this.timers.setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }
  /** Writes waiting frames, oldest topic first, while the buffer has room. */
  flush() {
    if (this.closed || this.tooSlow()) return;
    while (this.pending.size && this.ws.bufferedAmount <= QUEUE_BYTES) {
      const [topic, frame] = this.pending.entries().next().value;
      this.pending.delete(topic);
      this.write(frame);
    }
    if (!this.pending.size && this.ws.bufferedAmount <= QUEUE_BYTES) this.stopFlush();
  }
  stopFlush() {
    if (this.flushTimer) this.timers.clearInterval(this.flushTimer);
    this.flushTimer = null;
  }
  /** Drops every subscription; with `code`, closes the socket too. */
  close(code) {
    if (this.closed) return;
    this.closed = true;
    this.offHub?.();
    this.offHub = null;
    this.stopFlush();
    this.pending.clear();
    const held = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const entry of held) entry.unsubscribe();
    if (code !== undefined) this.ws.close(code);
  }
}
