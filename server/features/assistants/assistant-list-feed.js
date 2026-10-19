// The agent list and the sidebar, pushed as diffs on /api/assistant-events: one
// debounced read of the list for every tab and device, encoded with the session
// chat's ChatSync against each subscriber's cursor. A recompute without differences
// sends nothing. The list becomes rows keyed by section and id (`listRows`); the
// browser applies the deltas with `applyChatSync` and rebuilds the list.
import { createHash } from "node:crypto";
import { ChatSync } from "../chat/chat-sync.js";
import { runtimeView } from "./runtime-view.js";

export const LIST_CURSOR = /^[A-Za-z0-9-]{1,64}$/;
// Every list of one service shares this baseline scope; its own ChatSync instance
// means a cursor from an earlier service (an AgentPier restart) is unknown.
const scope = ["assistant-list"];

const keyed = (items) =>
  items.every((item) => item && typeof item.id === "string") &&
  new Set(items.map((item) => item.id)).size === items.length;
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The list as ChatSync rows: an array of items with unique ids becomes one row per
 * item, an object one row per key, anything else one row for the section. `shape`
 * says how each section is rebuilt, so empty sections survive the round trip.
 */
export function listRows(list) {
  const shape = {};
  const messages = [];
  for (const [section, value] of Object.entries(list || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value) && keyed(value)) {
      shape[section] = "array";
      for (const item of value)
        messages.push({ id: `${section}/${item.id}`, section, value: item });
    } else if (plain(value)) {
      shape[section] = "object";
      for (const [key, entry] of Object.entries(value))
        if (entry !== undefined)
          messages.push({ id: `${section}/${key}`, section, key, value: entry });
    } else {
      shape[section] = "value";
      messages.push({ id: section, section, value });
    }
  }
  return { shape, messages };
}

export class AssistantListFeed {
  /** `read()` returns the list (sync or async); `debounceMs` batches invalidations. */
  constructor({ read, sync = new ChatSync({}), debounceMs = 200 }) {
    Object.assign(this, { read, sync, debounceMs });
    this.subscribers = new Set();
    this.waiting = new Set();
    this.dirty = false;
    this.closed = false;
  }
  /**
   * Sends `{type: "sync", data}` with the list encoded against `cursor` now (a
   * settled value) and after the next read, then on every change. A failed read
   * sends `{type: "list-error"}`. Returns the unsubscribe function.
   */
  subscribe({ cursor } = {}, send) {
    if (this.closed) throw new Error("The agent list feed is closed");
    const subscriber = {
      send,
      cursor: LIST_CURSOR.test(cursor || "") ? cursor : undefined,
      issued: false,
    };
    this.subscribers.add(subscriber);
    this.waiting.add(subscriber);
    // Another tab keeps the feed current: its settled value answers at once, and the
    // read below still observes changes nobody announced.
    const cached = !this.dirty && !this.pending ? this.value : null;
    if (cached)
      queueMicrotask(() => {
        if (this.waiting.has(subscriber) && this.value === cached)
          this.deliver([subscriber], cached, new Map());
      });
    this.schedule();
    return () => {
      this.subscribers.delete(subscriber);
      this.waiting.delete(subscriber);
      // A reconnecting tab resumes from its cursor; a shared one stays active.
      const shared = [...this.subscribers].some((s) => s.cursor === subscriber.cursor);
      if (subscriber.issued && subscriber.cursor && !shared)
        this.sync.park(subscriber.cursor);
    };
  }
  /** The list changed: read it again (debounced; nothing to do without subscribers). */
  invalidate() {
    if (this.subscribers.size) this.schedule();
  }
  schedule() {
    if (this.closed) return;
    this.dirty = true;
    if (this.pending || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.refresh().finally(() => {
        this.pending = null;
        if (this.dirty && this.subscribers.size) this.schedule();
      });
    }, this.debounceMs);
    this.timer.unref?.();
  }
  async refresh() {
    this.dirty = false;
    if (!this.subscribers.size) return;
    try {
      const snapshot = listRows(await this.read());
      if (this.closed) return;
      const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      // An unchanged recompute answers only the subscribers still waiting.
      const targets = this.digest === digest ? this.waiting : this.subscribers;
      this.digest = digest;
      this.value = snapshot;
      this.deliver([...targets], snapshot, new Map());
    } catch {
      if (!this.closed)
        for (const subscriber of [...this.subscribers])
          subscriber.send({ type: "list-error" });
    }
  }
  /** Encodes once per distinct baseline: subscribers on one cursor share a frame. */
  deliver(subscribers, snapshot, encoded) {
    for (const subscriber of subscribers) {
      const first = this.waiting.delete(subscriber);
      const key = subscriber.cursor || "";
      if (!encoded.has(key))
        encoded.set(key, this.sync.encodeScoped(scope, snapshot, subscriber.cursor));
      const data = encoded.get(key);
      subscriber.cursor = data.sync.cursor || undefined;
      subscriber.issued = true;
      // A recompute with no difference for this subscriber sends nothing.
      if (!first && data.sync.mode === "delta" && data.sync.base === data.sync.cursor)
        continue;
      subscriber.send({ type: "sync", data });
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.subscribers.clear();
    this.waiting.clear();
  }
}

/**
 * The list feed of an AssistantService: its list with the runtime view, read again on
 * every `change` and `runtime` event of the service.
 */
export function assistantListFeed(service, options = {}) {
  const feed = new AssistantListFeed({
    read: () => ({
      ...service.list(),
      runtime: runtimeView({
        runtime: service.runtime,
        assistants: service,
        bridge: service.teams?.bridge,
        webTools: service.webTools,
      }),
    }),
    ...options,
  });
  service.events.subscribe((event) => {
    if (event.type === "change" || event.type === "runtime") feed.invalidate();
  });
  return feed;
}
