import { ClaudeHistoryIndex } from "./claude-history-index.js";
import { ClaudeHistoryMetadata } from "./claude-history-metadata.js";
import { normalizeClaude } from "./history-parsers.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const same = (a, b) =>
  a &&
  b &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtime === b.mtime;
const mismatch = () => problem(serverMessages.chat.sessionHistoryMismatch, 409);
const scope = (session, id, file) =>
  JSON.stringify([session.accountId, session.cwd, id, file]);

/** Shared background source indexes, bounded by active/recent viewed sessions. */
export class ClaudeHistoryPages {
  constructor({ onIndexed, maxEntries = 16 } = {}) {
    this.entries = new Map();
    this.onIndexed = onIndexed;
    this.maxEntries = maxEntries;
    this.closing = new Set();
  }
  entry(session, id, file) {
    if (this.closed) throw problem(serverMessages.chat.serviceStopping, 503);
    let entry = this.entries.get(session.id);
    const key = scope(session, id, file);
    if (entry && entry.scope !== key) {
      this.dispose(session.id, entry);
      entry = null;
    }
    if (!entry) {
      entry = {
        scope: key,
        metadata: new ClaudeHistoryMetadata(),
        session: { ...session },
        id,
      };
      entry.index = new ClaudeHistoryIndex({
        file,
        onRecords: (records) => entry.metadata.update(records),
        onReset: () => {
          entry.metadata = new ClaudeHistoryMetadata();
        },
        onReady: ({ identity, generation }) => {
          if (this.entries.get(session.id) !== entry || this.closed) return;
          const replaced = entry.published !== generation;
          entry.published = generation;
          entry.identity = identity;
          void Promise.resolve(
            this.onIndexed?.({ session: entry.session, id, replaced }),
          ).catch(() => {});
        },
      });
    }
    this.entries.delete(session.id);
    this.entries.set(session.id, entry);
    while (this.entries.size > this.maxEntries) {
      const [key, oldest] = this.entries.entries().next().value;
      this.dispose(key, oldest);
    }
    return entry;
  }
  async read(session, id, reader, state) {
    const entry = this.entry(session, id, reader.file);
    if (state && !state.indexed) return null; // Keep provisional cursor semantics until invalidated.
    if (state?.indexed && state.indexed.generation !== entry.index.generation)
      throw mismatch();
    if (!entry.index.ready(reader.identity)) {
      if (state?.indexed) throw mismatch();
      return null;
    }
    if (state?.remaining?.length) {
      await reader.validate();
      return this.split(entry, reader.identity, state.remaining, state.indexed.before);
    }
    const page = await entry.index.page({
      identity: reader.identity,
      before: state?.indexed.before,
      generation: state?.indexed.generation,
      limit: 50,
    });
    if (!page) {
      if (state) throw mismatch();
      return null;
    }
    await reader.validate();
    return this.split(
      entry,
      reader.identity,
      normalizeClaude(page.records).messages,
      page.nextBefore,
    );
  }
  split(entry, identity, messages, before) {
    const start = Math.max(0, messages.length - 50);
    return {
      messages: messages.slice(start),
      ...entry.metadata.snapshot(),
      next:
        start || before !== null
          ? {
              identity,
              indexed: { generation: entry.index.generation, before },
              ...(start ? { remaining: messages.slice(0, start) } : {}),
            }
          : null,
    };
  }
  warming(session, id, identity) {
    const entry = this.entries.get(session.id);
    return Boolean(
      entry &&
      entry.id === id &&
      (!same(entry.failed, identity) || Date.now() >= entry.retryAfter),
    );
  }
  warm(session, id, identity) {
    const entry = this.entries.get(session.id);
    if (
      !entry ||
      entry.id !== id ||
      this.closed ||
      (same(entry.failed, identity) && Date.now() < entry.retryAfter)
    )
      return;
    entry.target = identity;
    if (entry.scheduled || entry.pending) return;
    entry.scheduled = setImmediate(() => {
      entry.scheduled = null;
      if (this.entries.get(session.id) !== entry || this.closed) return;
      const target = entry.target;
      entry.pending = Promise.resolve(entry.index.refresh(target))
        .catch(() => {
          entry.failed = target;
          entry.retryAfter = Date.now() + 30000;
          if (!this.closed && this.entries.get(session.id) === entry)
            return Promise.resolve(
              this.onIndexed?.({ session: entry.session, id, replaced: false }),
            ).catch(() => {});
        })
        .finally(() => {
          entry.pending = null;
          if (entry.target !== target) this.warm(session, id, entry.target);
        });
    });
  }
  dispose(id, entry) {
    this.entries.delete(id);
    clearImmediate(entry.scheduled);
    const closing = Promise.resolve(entry.index.close())
      .catch(() => {})
      .finally(() => this.closing.delete(closing));
    this.closing.add(closing);
  }
  async close() {
    this.closed = true;
    for (const [id, entry] of this.entries) this.dispose(id, entry);
    await Promise.all(this.closing);
  }
}
