import { createHash, randomUUID } from "node:crypto";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bounded transport baselines. Authorization and image filtering run on every read. */
export class ChatSync {
  constructor({
    sessions,
    chatImages,
    now = Date.now,
    ttl = 30 * 60000,
    maxEntries = 512,
    maxBytes = 16 * 1024 * 1024,
  }) {
    Object.assign(this, { sessions, chatImages, now, ttl, maxEntries, maxBytes });
    this.cache = new Map();
    this.parked = new Map();
    this.bytes = 0;
  }
  drop(cursor) {
    this.bytes -= (this.cache.get(cursor) || this.parked.get(cursor))?.bytes || 0;
    this.cache.delete(cursor);
    this.parked.delete(cursor);
  }
  /** Removes every baseline, active or parked, that belongs to a session. */
  discard(sessionId) {
    for (const map of [this.cache, this.parked])
      for (const [cursor, entry] of [...map]) {
        let owner;
        try {
          owner = JSON.parse(entry.scope)[0];
        } catch {
          continue;
        }
        if (owner === sessionId) this.drop(cursor);
      }
  }
  /** Keeps a closed connection's last baseline outside the per-scope active limit. */
  park(cursor) {
    const entry = typeof cursor === "string" ? this.cache.get(cursor) : null;
    if (!entry || entry.expires <= this.now()) return;
    this.cache.delete(cursor);
    entry.expires = this.now() + this.ttl;
    this.parked.set(cursor, entry);
    const scoped = [...this.parked].filter(([, other]) => other.scope === entry.scope);
    for (const [old] of scoped.slice(0, Math.max(0, scoped.length - 2))) this.drop(old);
    while (this.parked.size > 256) this.drop(this.parked.keys().next().value);
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
    for (const [old] of scoped.slice(0, Math.max(0, scoped.length - 8))) this.drop(old);
    // Parked entries are evicted first under maxEntries/maxBytes pressure.
    while (
      this.cache.size + this.parked.size > this.maxEntries ||
      this.bytes > this.maxBytes
    )
      this.drop(
        this.parked.size
          ? this.parked.keys().next().value
          : this.cache.keys().next().value,
      );
    return this.cache.has(cursor) ? cursor : null;
  }
  async read(id, cursor) {
    const session = await this.sessions.get(id);
    // Only the stream adds nativeInput; normalizing keeps cursors valid across transports.
    const snapshot = { ...(await this.chatImages.read(id)), nativeInput: null };
    return this.encode(session, snapshot, cursor);
  }
  encode(session, snapshot, cursor) {
    for (const map of [this.cache, this.parked])
      for (const [key, entry] of [...map])
        if (entry.expires <= this.now()) this.drop(key);
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
      session.id,
      session.accountId,
      session.tool,
      session.createdAt || null,
      snapshot.providerSessionId || null,
    ]);
    const base =
      typeof cursor === "string"
        ? this.cache.get(cursor) || this.parked.get(cursor)
        : null;
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
