// The tab's one live channel, GET /api/live (server/http/live-websocket.js). Topics
// are subscribed with what the tab already holds (`have`), so a reconnect costs no
// REST call: the server answers `same`, a row `delta` or a `snapshot`.
//
// Hidden tabs: sampled topics are unsubscribed at once (the server stops its tmux
// captures), event topics stay. After five minutes hidden, or on `pagehide` (an open
// socket keeps the page out of the back/forward cache), the socket closes, and
// nothing reconnects until the tab is visible again. After three handshakes in a row
// fail, `status().fallback` asks useLiveTopic to poll REST while the socket is still
// retried with backoff.
import { applyListSync } from "./list-sync.js";
import { liveEnvironment } from "./live-environment.js";
import { topicInfo } from "./live-topics.js";

export const failuresBeforeFallback = 3;
export const hiddenCloseMs = 300000;
export const liveAuthCheckEvent = "agentpier-live-auth-check";

const pingMs = 25000;
// A connection counts as working, and the backoff starts over, only after it stayed
// open this long: a server that sends hello and closes at once (1008, 1009, 1013)
// must not be reconnected every half second.
const stableMs = 10000;
const firstDelayMs = 500;
const maxDelayMs = 30000;
const OPEN = 1;

const report = (error) =>
  queueMicrotask(() => {
    throw error;
  });

export class LiveClient {
  constructor(env) {
    this.env = env;
    this.topics = new Map();
    this.socket = null;
    this.connected = false;
    this.instance = null;
    this.failures = 0;
    this.attempt = 0;
    this.fallback = false;
    this.suspended = false;
    this.closed = false;
    this.lastHeard = 0;
    this.timers = { retry: null, ping: null, hidden: null, stable: null };
    this.shown = { connected: false, fallback: false };
    const { document, window } = env;
    this.handlers = [
      [document, "visibilitychange", () => (document.hidden ? this.hide() : this.show())],
      [window, "pagehide", () => this.suspend()],
      [
        window,
        "pageshow",
        () => {
          this.suspended = false;
          this.resume();
        },
      ],
      [window, "online", () => this.resume()],
    ];
    for (const [target, name, handler] of this.handlers)
      target.addEventListener(name, handler);
  }

  /** Listens to `topicId`; the returned function ends this listener. */
  subscribe(topicId, listener, { sampled = false } = {}) {
    if (this.closed) return () => {};
    const info = topicInfo(topicId);
    let entry = this.topics.get(topicId);
    if (!entry) {
      entry = {
        id: topicId,
        mode: info?.mode || "state",
        records: new Set(),
        held: null,
        // The last stale or refusal frame while no data is held, replayed to later
        // listeners so they read over REST or fall back instead of waiting.
        condition: null,
        rows: null,
        have: null,
        live: false,
        refused: false,
      };
      this.topics.set(topicId, entry);
    }
    const record = { listener, sampled: sampled || Boolean(info?.sampled) };
    entry.records.add(record);
    if (entry.held) this.call(record, { type: "data", ...entry.held });
    else if (entry.condition) this.call(record, entry.condition);
    if (this.socket) this.sync();
    // During an outage the pending retry keeps its backoff.
    else if (this.timers.retry === null) this.connect();
    return () => {
      if (!entry.records.delete(record) || this.topics.get(topicId) !== entry) return;
      if (entry.records.size) return this.sync();
      this.topics.delete(topicId);
      if (entry.live) this.send({ op: "unsub", topic: topicId });
    };
  }

  /**
   * Reports the tab's view over the open socket (push presence); false when the
   * channel is not open, so the caller reports over REST instead.
   */
  sendPresence(route) {
    if (!this.connected || this.fallback || this.socket?.readyState !== OPEN)
      return false;
    this.send({ op: "presence", route });
    return true;
  }

  status() {
    return { connected: this.connected, fallback: this.fallback };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
    for (const [target, name, handler] of this.handlers)
      target.removeEventListener(name, handler);
    this.topics.clear();
  }

  // --- connection -------------------------------------------------------------

  allowed() {
    return (
      !this.closed && !this.suspended && !this.env.document.hidden && this.topics.size > 0
    );
  }

  connect() {
    if (this.socket || !this.allowed()) return;
    this.clear("retry");
    let socket;
    try {
      socket = new this.env.WebSocket(this.env.url);
    } catch {
      this.failures += 1;
      return this.lost(1006);
    }
    this.socket = socket;
    this.connected = false;
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.dropped(event.code);
    };
    socket.onerror = () => {};
  }

  /** Closes the socket on purpose: no failure is counted and nothing reconnects. */
  disconnect() {
    const socket = this.detach();
    this.clear("retry");
    if (socket)
      try {
        socket.close(1000);
      } catch {
        // Already closing.
      }
    this.publishStatus();
  }

  detach() {
    const { socket } = this;
    this.socket = null;
    this.connected = false;
    this.clear("ping");
    this.clear("hidden");
    this.clear("stable");
    for (const entry of this.topics.values()) entry.live = false;
    if (socket) socket.onmessage = socket.onclose = socket.onerror = null;
    return socket;
  }

  dropped(code) {
    if (!this.connected) this.failures += 1;
    this.detach();
    if (code === 1008) this.env.window.dispatchEvent(new Event(liveAuthCheckEvent));
    this.lost(code);
  }

  lost(code) {
    if (this.failures >= failuresBeforeFallback) this.fallback = true;
    this.publishStatus();
    this.retry(code === 1012 ? 0 : this.backoff());
  }

  backoff() {
    const base = Math.min(maxDelayMs, firstDelayMs * 2 ** this.attempt);
    this.attempt += 1;
    return Math.min(maxDelayMs, Math.round(base * (1 + 0.5 * this.env.random())));
  }

  retry(delay) {
    this.clear("retry");
    if (!this.allowed()) return;
    this.timers.retry = this.env.setTimeout(() => {
      this.timers.retry = null;
      this.connect();
    }, delay);
  }

  clear(name) {
    if (this.timers[name] === null) return;
    this.env.clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  ping() {
    this.timers.ping = this.env.setTimeout(() => {
      this.timers.ping = null;
      // Nothing heard for two pings: the connection died without a close (sleep).
      if (this.env.now() - this.lastHeard >= 2 * pingMs) {
        const socket = this.socket;
        this.detach();
        try {
          socket?.close(1000);
        } catch {
          // Already closing.
        }
        return this.lost(1006);
      }
      this.send({ op: "ping" });
      this.ping();
    }, pingMs);
  }

  publishStatus() {
    const next = this.status();
    if (next.connected === this.shown.connected && next.fallback === this.shown.fallback)
      return;
    this.shown = next;
    for (const entry of [...this.topics.values()])
      this.emit(entry, { type: "status", ...next });
  }

  // --- visibility ---------------------------------------------------------------

  hide() {
    this.clear("retry");
    this.sync();
    if (this.socket && this.timers.hidden === null)
      this.timers.hidden = this.env.setTimeout(() => {
        this.timers.hidden = null;
        this.disconnect();
      }, hiddenCloseMs);
  }

  show() {
    this.suspended = false;
    this.clear("hidden");
    if (this.socket) this.sync();
    else this.connect();
  }

  suspend() {
    this.suspended = true;
    this.disconnect();
  }

  resume() {
    if (!this.env.document.hidden && !this.socket) this.connect();
  }

  // --- frames -----------------------------------------------------------------

  send(frame) {
    if (!this.connected || this.socket?.readyState !== OPEN) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // The close event follows.
    }
  }

  /** Subscribes what the tab wants now: no sampled topic while hidden. */
  sync() {
    if (!this.connected) return;
    const hidden = this.env.document.hidden;
    for (const entry of this.topics.values()) {
      const sampled = [...entry.records].some((record) => record.sampled);
      const wanted = !entry.refused && !(hidden && sampled);
      if (wanted && !entry.live) {
        entry.live = true;
        this.send(
          entry.have
            ? { op: "sub", topic: entry.id, have: entry.have }
            : { op: "sub", topic: entry.id },
        );
      } else if (!wanted && entry.live) {
        entry.live = false;
        this.send({ op: "unsub", topic: entry.id });
      }
    }
  }

  receive(text) {
    this.lastHeard = this.env.now();
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "hello") return this.hello(frame);
    const entry = this.topics.get(frame.topic);
    if (entry?.live) this.topicFrame(entry, frame);
  }

  hello(frame) {
    this.connected = true;
    this.instance = frame.instance;
    this.failures = 0;
    this.fallback = false;
    this.timers.stable = this.env.setTimeout(() => {
      this.timers.stable = null;
      this.attempt = 0;
    }, stableMs);
    for (const entry of this.topics.values()) {
      if (entry.refused) entry.condition = null;
      entry.refused = false;
    }
    this.publishStatus();
    this.ping();
    this.sync();
  }

  topicFrame(entry, frame) {
    const { type, revision } = frame;
    if (type === "snapshot" || type === "state" || type === "delta")
      return this.apply(entry, frame);
    if (type === "same") {
      // A signal holds its revision from the first answer on: a change missed while
      // the socket was down then comes back as `changed` on the resubscribe.
      if (entry.mode === "signal" || (entry.mode !== "rows" && entry.have))
        entry.have = { instance: this.instance, revision };
    } else if (type === "changed") {
      entry.have = { instance: this.instance, revision };
      this.emit(entry, { type: "changed" });
    } else if (type === "stale") {
      // The pushed value is not coming; useLiveTopic reads it over REST.
      entry.rows = entry.have = entry.held = null;
      this.condition(entry, { type: "stale" });
    } else if (type === "revoked") {
      entry.live = false;
      entry.refused = true;
      entry.held = null;
      this.condition(entry, { type: "revoked" });
    } else if (type === "error") {
      if (frame.code) {
        // The server holds an unknown topic's slot until the client lets go.
        entry.live = false;
        entry.refused = true;
        entry.held = null;
        if (frame.code === "unknown-topic") this.send({ op: "unsub", topic: entry.id });
        return this.condition(entry, { type: "error", code: frame.code });
      }
      this.emit(entry, { type: "error" });
    }
  }

  apply(entry, frame) {
    let data;
    if (entry.mode === "rows") {
      let rows;
      try {
        rows = applyListSync(entry.rows, frame.data);
      } catch {
        // Not onto the held baseline: ask for the whole list again.
        entry.rows = entry.have = null;
        return this.send({ op: "sub", topic: entry.id });
      }
      entry.rows = rows;
      entry.have = { instance: this.instance, cursor: rows.state.sync.cursor };
      data = rows.list;
    } else {
      entry.have = { instance: this.instance, revision: frame.revision };
      data = frame.data;
    }
    entry.held = { data, revision: frame.revision };
    entry.condition = null;
    this.emit(entry, { type: "data", ...entry.held });
  }

  condition(entry, event) {
    entry.condition = event;
    this.emit(entry, event);
  }

  emit(entry, event) {
    for (const record of [...entry.records]) this.call(record, event);
  }

  call(record, event) {
    try {
      record.listener(event);
    } catch (error) {
      report(error);
    }
  }
}

let shared = null;

/** The tab's live client, made on first use. */
export function liveClient() {
  shared ??= new LiveClient(liveEnvironment());
  return shared;
}
