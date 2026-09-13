import { watchNativeInput } from "./native-input-watch.js";
import { createHash } from "node:crypto";
import { watchChatSources } from "./chat-source-watch.js";

/** One serialized source reader per watched session, shared by all browser tabs. */
export class ChatStreams {
  constructor({
    sessions,
    chat,
    chatImages,
    chatEvents,
    accounts,
    config,
    watch = watchChatSources,
    watchInput = watchNativeInput,
    debounceMs = 150,
    recoveryMs = 30000,
  }) {
    Object.assign(this, {
      sessions,
      chat,
      chatImages,
      chatEvents,
      accounts,
      config,
      watch,
      watchInput,
      debounceMs,
      recoveryMs,
    });
    this.entries = new Map();
  }
  subscribe(id, listener) {
    if (this.closed) throw new Error("Chat stream is closed");
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        id,
        listeners: new Set(),
        waiting: new Set(),
        generation: 0,
        dirty: false,
        refreshSource: false,
        disposed: false,
      };
      this.entries.set(id, entry);
      entry.unsubscribe = this.chatEvents.subscribe(id, (event) => {
        if (event.type === "binding-changed") {
          entry.generation++;
          entry.value = null;
          entry.digest = null;
          entry.input = null;
        }
        this.invalidate(entry, event.type !== "snapshot-changed");
      });
      entry.recovery = setInterval(() => {
        entry.unwatch?.();
        entry.unwatch = null;
        entry.unwatchInput?.();
        entry.unwatchInput = null;
        entry.input = null;
        this.invalidate(entry);
      }, this.recoveryMs);
      entry.recovery.unref();
    }
    entry.listeners.add(listener);
    entry.waiting.add(listener);
    if (entry.value && !entry.dirty && !entry.pending)
      queueMicrotask(() => {
        if (entry.listeners.has(listener) && !entry.dirty && !entry.pending) {
          entry.waiting.delete(listener);
          listener(entry.value);
        }
      });
    else if (!entry.pending && !entry.timer) this.invalidate(entry);
    return () => {
      entry.listeners.delete(listener);
      entry.waiting.delete(listener);
      if (!entry.listeners.size) this.dispose(entry);
    };
  }
  invalidate(entry, refreshSource = true) {
    if (entry.disposed || this.closed) return;
    entry.dirty = true;
    entry.refreshSource ||= refreshSource;
    if (entry.pending || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.pending = this.refresh(entry).finally(() => {
        entry.pending = null;
        if (entry.dirty) this.invalidate(entry, false);
      });
    }, this.debounceMs);
    entry.timer.unref();
  }
  async refresh(entry) {
    entry.dirty = false;
    const refreshSource = entry.refreshSource;
    entry.refreshSource = false;
    const generation = entry.generation;
    try {
      const session = await this.sessions.get(entry.id);
      if (entry.disposed) return;
      const scope = JSON.stringify([session.accountId, session.tool, session.cwd]);
      const scopeChanged = entry.scope !== scope;
      if (scopeChanged) {
        entry.unwatch?.();
        entry.unwatch = null;
        entry.scope = scope;
        entry.unwatchInput?.();
        entry.unwatchInput = null;
        entry.input = null;
      }
      if (
        !entry.unwatch &&
        !["shell"].includes(session.tool) &&
        session.purpose !== "login"
      ) {
        entry.unwatch = this.watch(
          { session, accounts: this.accounts, ...this.config },
          () => this.invalidate(entry),
        );
      }
      if (
        !entry.unwatchInput &&
        session.status === "running" &&
        ["claude", "codex", "opencode"].includes(session.tool) &&
        !session.purpose &&
        this.sessions.tmuxPath
      ) {
        entry.unwatchInput = this.watchInput(
          { sessions: this.sessions, session },
          (input) => {
            entry.input = input;
            // SQLite WAL writes may not notify fs.watch on every platform. A
            // changed native queue is also a bounded history invalidation hint.
            this.invalidate(entry);
            if (entry.value)
              this.publish(entry, entry.value.session, entry.value.snapshot);
          },
        );
      }
      if (session.status !== "running") {
        entry.unwatchInput?.();
        entry.unwatchInput = null;
        entry.input = null;
      }
      // A real source event invalidates the short HTTP cache, but the store owns
      // single-flight history reads so an earlier slow request is never duplicated.
      // Completion hints announce a freshly cached background result. Re-reading
      // its source here would discard that result and restart a slow provider read.
      if (refreshSource || scopeChanged) {
        this.chat.invalidate(entry.id);
        this.chat.bindings?.processCache?.clear();
      }
      const snapshot = await this.chatImages.read(entry.id);
      if (entry.disposed || this.closed || entry.generation !== generation) return;
      this.publish(entry, session, snapshot);
    } catch (error) {
      if (!entry.disposed && !this.closed && entry.generation === generation)
        for (const listener of entry.listeners) listener({ error });
    }
  }
  publish(entry, session, snapshot) {
    if (entry.disposed || this.closed) return;
    snapshot = { ...snapshot, nativeInput: entry.input || null };
    const value = { session, snapshot };
    const digest = createHash("sha256")
      .update(JSON.stringify([entry.scope, session.status, snapshot]))
      .digest("hex");
    const listeners = entry.digest === digest ? entry.waiting : entry.listeners;
    entry.digest = digest;
    entry.value = value;
    for (const listener of listeners) {
      entry.waiting.delete(listener);
      listener(value);
    }
  }
  dispose(entry) {
    entry.disposed = true;
    clearTimeout(entry.timer);
    clearInterval(entry.recovery);
    entry.unsubscribe?.();
    entry.unwatch?.();
    entry.unwatchInput?.();
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) this.dispose(entry);
  }
}
