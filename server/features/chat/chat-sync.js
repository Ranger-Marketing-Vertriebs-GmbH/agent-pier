import { createHash, randomUUID } from "node:crypto";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bounded transport baselines. Authorization and image filtering run on every read. */
export class ChatSync {
  constructor({
    sessions,
    chatImages,
    now = Date.now,
    ttl = 120000,
    maxEntries = 128,
    maxBytes = 4 * 1024 * 1024,
  }) {
    Object.assign(this, { sessions, chatImages, now, ttl, maxEntries, maxBytes });
    this.cache = new Map();
    this.bytes = 0;
  }
  discard(cursor) {
    this.bytes -= this.cache.get(cursor)?.bytes || 0;
    this.cache.delete(cursor);
  }
  remember(scope, rows, digest) {
    for (const [cursor, entry] of this.cache) {
      if (entry.scope !== scope || entry.digest !== digest) continue;
      this.cache.delete(cursor);
      entry.expires = this.now() + this.ttl;
      this.cache.set(cursor, entry);
      return cursor;
    }
    const bytes = Buffer.byteLength(JSON.stringify([scope, [...rows], digest])) + 128;
    if (bytes > this.maxBytes) return null;
    const cursor = randomUUID();
    this.cache.set(cursor, {
      scope,
      rows,
      digest,
      bytes,
      expires: this.now() + this.ttl,
    });
    this.bytes += bytes;
    const scoped = [...this.cache].filter(([, entry]) => entry.scope === scope);
    for (const [old] of scoped.slice(0, Math.max(0, scoped.length - 8)))
      this.discard(old);
    while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes)
      this.discard(this.cache.keys().next().value);
    return this.cache.has(cursor) ? cursor : null;
  }
  async read(id, cursor) {
    const session = await this.sessions.get(id);
    const snapshot = await this.chatImages.read(id);
    for (const [key, entry] of this.cache)
      if (entry.expires <= this.now()) this.discard(key);
    const { messages, ...metadata } = snapshot;
    if (
      !Array.isArray(messages) ||
      messages.some((message) => !message || typeof message.id !== "string")
    )
      return { ...snapshot, sync: { mode: "full", cursor: null } };
    const rows = new Map(messages.map((message) => [message.id, hash(message)]));
    if (rows.size !== messages.length)
      return { ...snapshot, sync: { mode: "full", cursor: null } };
    const scope = JSON.stringify([
      id,
      session.accountId,
      session.tool,
      session.createdAt || null,
      snapshot.providerSessionId || null,
    ]);
    const base = typeof cursor === "string" ? this.cache.get(cursor) : null;
    const next = this.remember(scope, rows, hash([metadata, [...rows]]));
    if (!next || !base || base.scope !== scope)
      return { ...snapshot, sync: { mode: "full", cursor: next } };
    const order = [...rows.keys()];
    const oldOrder = [...base.rows.keys()];
    return {
      sync: { mode: "delta", base: cursor, cursor: next },
      metadata,
      upserts: messages.filter(
        (message) => base.rows.get(message.id) !== rows.get(message.id),
      ),
      removed: oldOrder.filter((key) => !rows.has(key)),
      ...(order.length !== oldOrder.length ||
      order.some((key, index) => key !== oldOrder[index])
        ? { order }
        : {}),
    };
  }
}
