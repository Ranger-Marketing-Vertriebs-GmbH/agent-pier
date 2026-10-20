import { watchNativeInput } from "./native-input-watch.js";
import { createHash } from "node:crypto";
import { watchChatSources } from "./chat-source-watch.js";
import { ChatSourceWatchPool } from "./chat-source-watch-pool.js";
import { probeChatSources } from "./chat-source-probe.js";
import { ReplyStreams } from "./reply-streams.js";

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
    // A re-check after the source watchers armed; see chat-source-watch.js.
    settleMs = 500,
    // The stat probe of the last read transcript files while a chat has viewers.
    probe = probeChatSources,
    probeMs = 1000,
    replies = {},
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
      settleMs,
      probe,
      probeMs,
    });
    this.entries = new Map();
    this.sourceWatches = new ChatSourceWatchPool();
    // Reply text streaming now; an ended run means the transcript has it: read again.
    this.replies = new ReplyStreams({ ...replies, onEnd: (id) => this.touch(id) });
  }
  /** A source changed outside the watchers: an open chat reads again. */
  touch(id) {
    const entry = this.entries.get(id);
    if (entry) this.invalidate(entry);
  }
  /** The live reply frames of session `id` (reply-streams.js). */
  subscribeReplies(id, send) {
    return this.replies.subscribe(id, send);
  }
  /** The provider-neutral reply entry point; see ReplyStreams.streamText. */
  streamText(id, runId, value) {
    return this.replies.streamText(id, runId, value);
  }
  endStream(id, runId, options) {
    this.replies.endStream(id, runId, options);
  }
  /** What the CLI reports doing now (live-status frames), or null. */
  setStatus(id, status) {
    this.replies.setStatus(id, status);
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
          entry.settled = false;
        }
        this.invalidate(entry, event.type !== "snapshot-changed");
      });
      entry.recovery = setInterval(() => {
        // Re-read missed changes without restarting healthy OS watches or tmux.
        entry.unwatchInput?.refresh?.();
        this.invalidate(entry);
      }, this.recoveryMs);
      entry.recovery.unref();
      // FSEvents can lag by seconds: a cheap stat catches what the watchers miss.
      entry.stopProbe = this.probe({
        sources: () => this.chat.sourceState?.(id, entry.session),
        changed: () => this.invalidate(entry),
        intervalMs: this.probeMs,
        maintain: () => entry.unwatch?.refresh?.(),
        discover: () => entry.value?.snapshot?.availability === "waiting",
      });
    }
    entry.listeners.add(listener);
    entry.waiting.add(listener);
    // Another tab may keep this entry alive: show its settled value at once, but
    // a new subscriber (a reload) must still observe the current source afterwards.
    // An already invalidated value is never used as a baseline.
    const cached = !entry.dirty && !entry.pending ? entry.value : null;
    if (cached)
      queueMicrotask(() => {
        if (entry.waiting.has(listener) && entry.value === cached) {
          entry.waiting.delete(listener);
          listener(cached);
        }
      });
    this.invalidate(entry);
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
      entry.session = session;
      const scope = JSON.stringify([session.accountId, session.tool, session.cwd]);
      const scopeChanged = entry.scope !== scope;
      if (scopeChanged) {
        entry.unwatch?.();
        entry.unwatch = null;
        entry.scope = scope;
        entry.unwatchInput?.();
        entry.unwatchInput = null;
        entry.input = null;
        entry.settled = false;
      }
      if (
        !entry.unwatch &&
        !["shell"].includes(session.tool) &&
        session.purpose !== "login"
      ) {
        entry.unwatch = this.watch(
          {
            session,
            accounts: this.accounts,
            ...this.config,
            settleMs: this.settleMs,
            pool: this.sourceWatches,
            sources: () => this.chat.sourceState?.(entry.id, session),
            discover: () => entry.settled,
          },
          () => this.invalidate(entry),
        );
      }
      if (
        !entry.unwatchInput &&
        Date.now() >= (entry.inputRetryAt || 0) &&
        session.status === "running" &&
        ["claude", "codex", "opencode"].includes(session.tool) &&
        !session.purpose &&
        this.sessions.tmuxPath
      ) {
        let exited = false,
          unwatch;
        const onExit = () => {
          exited = true;
          this.inputExited(entry, unwatch);
        };
        unwatch = this.watchInput(
          { sessions: this.sessions, session, onExit },
          (input) => {
            if (input) entry.inputExits = 0;
            entry.input = input;
            // SQLite WAL writes may not notify fs.watch on every platform. A
            // changed native queue is also a bounded history invalidation hint.
            this.invalidate(entry);
            if (entry.value)
              this.publish(entry, entry.value.session, entry.value.snapshot);
          },
        );
        if (!exited) entry.unwatchInput = unwatch;
      }
      if (session.status !== "running") {
        entry.unwatchInput?.();
        entry.unwatchInput = null;
        entry.input = null;
      }
      // A real source event invalidates the short HTTP cache. The store keeps one
      // provider read per session and queues at most one follow-up, so a read that
      // opened before the change is never reused and reads never pile up.
      // Completion hints announce a freshly cached background result. Re-reading
      // its source here would discard that result and restart a slow provider read.
      if (refreshSource || scopeChanged) {
        this.chat.invalidate(entry.id);
        this.chat.bindings?.processCache?.clear();
      }
      const snapshot = await this.chatImages.read(entry.id);
      if (entry.disposed || this.closed || entry.generation !== generation) return;
      // A saved snapshot served while the provider read continues has no sources yet.
      entry.settled = !this.chat.reading?.(entry.id);
      await entry.unwatch?.refresh?.();
      if (entry.disposed || this.closed || entry.generation !== generation) return;
      this.publish(entry, session, snapshot);
    } catch (error) {
      if (!entry.disposed && !this.closed && entry.generation === generation)
        for (const listener of entry.listeners) listener({ error });
    }
  }
  /** A lost tmux control client is reattached by a later refresh, with backoff. */
  inputExited(entry, unwatch) {
    if (entry.disposed || this.closed || (unwatch && entry.unwatchInput !== unwatch))
      return;
    entry.unwatchInput = null;
    const delay = Math.min(this.recoveryMs, 1000 * 2 ** (entry.inputExits || 0));
    entry.inputExits = (entry.inputExits || 0) + 1;
    entry.inputRetryAt = Date.now() + delay;
    clearTimeout(entry.inputRetry);
    entry.inputRetry = setTimeout(() => this.invalidate(entry, false), delay);
    entry.inputRetry.unref();
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
    clearTimeout(entry.inputRetry);
    clearInterval(entry.recovery);
    entry.stopProbe?.();
    entry.unsubscribe?.();
    entry.unwatch?.();
    entry.unwatchInput?.();
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
  }
  close() {
    this.closed = true;
    this.replies.close();
    for (const entry of this.entries.values()) this.dispose(entry);
  }
}
