// Live agent chats: one feed per open conversation, shared by every tab and device
// that watches it. A feed reads the latest history window once per invalidation
// (debounced) and sends each subscriber only what changed since its own cursor
// (chat-sync.js); streamed reply text goes out as appended parts.
import { createHash } from "node:crypto";
import { ChatSync } from "../chat/chat-sync.js";
import { conversationHistory } from "./conversations.js";
import { fromSince } from "../users/owner-privacy.js";
import { isUserAgent } from "../users/user-access.js";

export const CURSOR = /^[A-Za-z0-9-]{1,64}$/;
const live = new Set(["pending", "accepted", "running"]);
// Runs whose terminal frame never arrives are forgotten oldest first.
const maxRuns = 16;

/** Whether a turn of this history is still underway: the recovery re-read runs then. */
export function turnActive(snapshot) {
  return (
    !!snapshot?.compacting ||
    (snapshot?.requests || []).some(
      (r) => r.attempt && live.has(r.attempt.state) && !r.attempt.reviewedAt,
    )
  );
}

export class ConversationFeeds {
  /**
   * `read(id)` returns the latest history window, `scope(id)` the baseline scope
   * key ([conversationId, runtimeSessionKey, runtime generation]) and `runs(id)` the
   * replies streaming right now as [runId, text] pairs. `owner(id)` names the agent
   * whose chat the conversation is (invalidateOwners).
   */
  constructor({
    read,
    scope,
    runs = () => [],
    owner = () => null,
    sync = new ChatSync({}),
    debounceMs = 200,
    recoveryMs = 30000,
  }) {
    Object.assign(this, { read, scope, runs, owner, sync, debounceMs, recoveryMs });
    this.entries = new Map();
    this.epochs = 0;
    this.closed = false;
  }
  /**
   * Watches conversation `id`; `send` receives `{type: "sync", data}`, `{type:
   * "stream", runId, from, text}`, `{type: "error", error}` and `{type: "end"}`.
   * `cursor` is the subscriber's resume baseline; `since` (the owner reading a user's
   * chat under her opt-in) leaves out everything before it. Returns the unsubscribe
   * function.
   */
  subscribe(id, { cursor, since = null } = {}, send) {
    if (this.closed) throw new Error("Conversation feeds are closed");
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        id,
        subscribers: new Set(),
        waiting: new Set(),
        runs: new Map(),
        dirty: false,
        disposed: false,
      };
      for (const [runId, text] of this.runs(id) || [])
        if (typeof text === "string")
          entry.runs.set(runId, { text, epoch: ++this.epochs });
      this.entries.set(id, entry);
      // A lost hint never leaves a running turn's chat behind for long.
      entry.recovery = setInterval(() => {
        if (entry.active) this.invalidate(id);
      }, this.recoveryMs);
      entry.recovery.unref?.();
    }
    const subscriber = {
      send,
      since,
      cursor: CURSOR.test(cursor || "") ? cursor : undefined,
      issued: false,
      runs: new Map(),
    };
    entry.subscribers.add(subscriber);
    entry.waiting.add(subscriber);
    // The reply streaming now, whole: this subscriber has seen none of it.
    for (const [runId, run] of entry.runs) this.streamTo(subscriber, runId, run);
    // Another tab keeps this feed alive: its settled value answers at once, and
    // the read below still observes the current history for the newcomer.
    const cached = !entry.dirty && !entry.pending ? entry.value : null;
    if (cached)
      queueMicrotask(() => {
        if (entry.waiting.has(subscriber) && entry.value === cached)
          this.deliver(entry, subscriber, cached, true);
      });
    this.schedule(entry);
    return () => {
      entry.subscribers.delete(subscriber);
      entry.waiting.delete(subscriber);
      if (subscriber.issued && subscriber.cursor) this.sync.park(subscriber.cursor);
      if (!entry.subscribers.size) this.dispose(entry);
    };
  }
  /** The conversation's history changed: its feed reads it again. */
  invalidate(id) {
    const entry = this.entries.get(id);
    if (entry) this.schedule(entry);
  }
  /** A change without a known conversation: every live feed reads again. */
  invalidateAll() {
    for (const entry of this.entries.values()) this.schedule(entry);
  }
  /** The pending actions of these agents changed: their open chats read again. */
  invalidateOwners(ids) {
    const owners = new Set(ids);
    if (!owners.size) return;
    for (const entry of this.entries.values()) {
      let owner;
      try {
        owner = this.owner(entry.id);
      } catch {
        // A conversation that is gone reads again and reports it.
        owner = null;
      }
      if (owner === null || owners.has(owner)) this.schedule(entry);
    }
  }
  schedule(entry) {
    if (entry.disposed || this.closed) return;
    entry.dirty = true;
    if (entry.pending || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.pending = this.refresh(entry).finally(() => {
        entry.pending = null;
        if (entry.dirty) this.schedule(entry);
      });
    }, this.debounceMs);
    entry.timer.unref?.();
  }
  async refresh(entry) {
    entry.dirty = false;
    try {
      const snapshot = await this.read(entry.id);
      if (entry.disposed || this.closed) return;
      const scope = this.scope(entry.id);
      entry.active = turnActive(snapshot) || entry.runs.size > 0;
      const value = { scope, snapshot };
      const digest = createHash("sha256")
        .update(JSON.stringify([scope, snapshot]))
        .digest("hex");
      // An unchanged recompute answers only the subscribers still waiting.
      const targets = entry.digest === digest ? entry.waiting : entry.subscribers;
      entry.digest = digest;
      entry.value = value;
      for (const subscriber of [...targets])
        this.deliver(entry, subscriber, value, entry.waiting.has(subscriber));
    } catch (error) {
      if (!entry.disposed && !this.closed)
        for (const subscriber of [...entry.subscribers])
          subscriber.send({ type: "error", error });
    }
  }
  deliver(entry, subscriber, { scope, snapshot }, first) {
    entry.waiting.delete(subscriber);
    const data = this.sync.encodeScoped(
      scope,
      fromSince(snapshot, subscriber.since),
      subscriber.cursor,
    );
    subscriber.cursor = data.sync.cursor;
    subscriber.issued = true;
    // A recompute with no difference for this subscriber sends nothing.
    if (!first && data.sync.mode === "delta" && data.sync.base === data.sync.cursor)
      return;
    subscriber.send({ type: "sync", data });
  }
  /** The reply so far of `runId` (chat-stream.js); subscribers get what they lack. */
  stream(id, runId, text) {
    const entry = this.entries.get(id);
    if (!entry || typeof text !== "string") return;
    let run = entry.runs.get(runId);
    // A rewrite (not an append) restarts the run for every subscriber.
    if (!run || !text.startsWith(run.text)) {
      entry.runs.delete(runId);
      run = { text, epoch: ++this.epochs };
      entry.runs.set(runId, run);
      if (entry.runs.size > maxRuns) this.forget(entry, entry.runs.keys().next().value);
    } else run.text = text;
    entry.active = true;
    for (const subscriber of [...entry.subscribers])
      this.streamTo(subscriber, runId, run);
  }
  streamTo(subscriber, runId, run) {
    const sent = subscriber.runs.get(runId);
    const from = sent?.epoch === run.epoch ? sent.length : 0;
    if (sent?.epoch === run.epoch && run.text.length <= from) return;
    subscriber.runs.set(runId, { epoch: run.epoch, length: run.text.length });
    subscriber.send({ type: "stream", runId, from, text: run.text.slice(from) });
  }
  /** The run ended: its text is history now, which the feed reads again. */
  endRun(id, runId) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.forget(entry, runId);
    this.schedule(entry);
  }
  forget(entry, runId) {
    entry.runs.delete(runId);
    for (const subscriber of entry.subscribers) subscriber.runs.delete(runId);
  }
  /** A new Gateway connection starts every run again with its whole text. */
  clearRuns() {
    for (const entry of this.entries.values())
      for (const runId of [...entry.runs.keys()]) this.forget(entry, runId);
  }
  /** The HTTP fallback: one read encoded against `cursor`, from `since` when given. */
  async snapshot(id, cursor, { since = null } = {}) {
    const snapshot = await this.read(id);
    return this.sync.encodeScoped(
      this.scope(id),
      fromSince(snapshot, since),
      CURSOR.test(cursor || "") ? cursor : undefined,
    );
  }
  dispose(entry) {
    entry.disposed = true;
    clearTimeout(entry.timer);
    clearInterval(entry.recovery);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
  }
  close() {
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      const subscribers = [...entry.subscribers];
      this.dispose(entry);
      for (const subscriber of subscribers) subscriber.send({ type: "end" });
    }
  }
}

/**
 * The feeds of an AssistantService: its history with the agent's pending actions
 * (AssistantWorkflows.pending), runtime and streaming replies.
 */
export function conversationFeeds(service, options = {}) {
  const owner = (id) => service.store.getConversation(id).assistantId;
  return new ConversationFeeds({
    read: async (id) => {
      const history = await conversationHistory(service, id);
      let actions = service.workflows?.pending(owner(id));
      // A user agent's chats are private to their person: each shows its own
      // approvals only (user agents have no team members to delegate to).
      if (actions && isUserAgent(service.store.getAssistant(owner(id))))
        actions = actions.filter((a) => a.conversationId === id);
      // Without the workflows the chat reads its actions itself.
      return actions ? { ...history, actions } : history;
    },
    owner,
    // A new runtime generation (a Gateway restart) never resumes an old baseline.
    scope: (id) => [
      id,
      service.store.getConversation(id).runtimeSessionKey,
      service.runtime.generationId ?? service.runtime.generation ?? null,
    ],
    runs: (id) => {
      const key = service.store.getConversation(id).runtimeSessionKey;
      return [...(service.chatStreams?.runs || [])]
        .filter(([, run]) => run.sessionKey === key)
        .map(([runId, run]) => [runId, run.text]);
    },
    ...options,
  });
}

// The last reconciled state of each conversation, per service.
const reconciled = new WeakMap();
/**
 * The conversations whose history (`reads`, read during the pass) or ledger turns
 * changed since the previous reconciliation pass.
 */
export function reconciledChanges(service, reads) {
  if (!reconciled.has(service)) reconciled.set(service, new Map());
  const last = reconciled.get(service);
  const changed = [];
  for (const [id, history] of reads) {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          history,
          service.ledger.requests(id).map((r) => service.ledger.attemptFor(r.id)),
        ]),
      )
      .digest("hex");
    if (last.get(id) !== digest) changed.push(id);
    last.set(id, digest);
  }
  return changed;
}
