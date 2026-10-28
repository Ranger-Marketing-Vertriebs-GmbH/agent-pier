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

const OPEN = 1;
const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The client frame as `{op, topic?, have?}`, or null when it is malformed. */
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
  }) {
    Object.assign(this, { ws, hub, principal, timers, maxTopics });
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
    else if (frame.op === "unsub") this.unsubscribe(frame.topic);
    else this.subscribe(frame.topic, frame.have);
    return true;
  }
  subscribe(topic, have) {
    const held = this.subscriptions.get(topic);
    if (!held && this.subscriptions.size >= this.maxTopics) {
      this.reply({ type: "error", topic: topic.slice(0, MAX_TOPIC_ID), code: "limit" });
      return;
    }
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
