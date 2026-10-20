import { createHash, randomBytes } from "node:crypto";

export const digest = (token) => createHash("sha256").update(token).digest("hex");
const day = 24 * 60 * 60 * 1000;
// Sliding sessions: each renewal grants a fresh idle window, never beyond the absolute cap.
export const idleDuration = 30 * day;
export const absoluteDuration = 90 * day;
export const sessionLimit = 20;
// setTimeout overflows above 2^31-1 ms and would fire at once.
const maxTimer = 2 ** 31 - 1;
const principalKey = (row) => row.userId ?? null;

// Session rows of one private file. The array is changed in place, so the owner of the
// file keeps the same reference it saves.
export class SessionLedger {
  constructor({ rows, save, now = Date.now }) {
    this.rows = rows;
    this.save = save;
    this.now = now;
    this.watchers = new Map();
  }
  issue(extra = {}) {
    const token = randomBytes(32).toString("hex");
    const now = this.now();
    this.remove((row) => row.expires <= now);
    const key = extra.userId ?? null;
    for (;;) {
      const own = this.rows.filter((row) => principalKey(row) === key);
      if (own.length < sessionLimit) break;
      this.revokeHash(
        own.reduce((oldest, row) => (row.lastUsed < oldest.lastUsed ? row : oldest)).hash,
      );
    }
    this.rows.push({
      hash: digest(token),
      ...extra,
      created: now,
      lastUsed: now,
      expires: now + idleDuration,
    });
    this.save();
    return token;
  }
  find(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = digest(token);
    return this.rows.find((row) => row.hash === hash && row.expires > this.now()) || null;
  }
  // In memory only; renewals and later writes persist it for eviction order.
  touch(row) {
    row.lastUsed = this.now();
  }
  // Returns the new cookie lifetime when the expiry moved, otherwise null. Writes happen only
  // once less than half the idle window remains, so at most about every fifteen days.
  renew(row) {
    const now = this.now();
    if (row.expires - now >= idleDuration / 2) return null;
    const expires = Math.min(now + idleDuration, row.created + absoluteDuration);
    if (expires <= row.expires) return null;
    row.expires = expires;
    this.save();
    for (const watcher of this.watchers.get(row.hash) || []) watcher.schedule();
    return expires - now;
  }
  revoke(token) {
    const row = this.find(token);
    if (!row) return;
    this.revokeHash(row.hash);
    this.save();
  }
  revokeHash(hash) {
    this.remove((row) => row.hash === hash);
    for (const watcher of this.watchers.get(hash) || []) {
      clearTimeout(watcher.timer);
      watcher.close();
    }
    this.watchers.delete(hash);
  }
  revokeWhere(predicate) {
    const hashes = this.rows.filter(predicate).map((row) => row.hash);
    for (const hash of hashes) this.revokeHash(hash);
    if (hashes.length) this.save();
  }
  remove(predicate) {
    for (let index = this.rows.length - 1; index >= 0; index--)
      if (predicate(this.rows[index])) this.rows.splice(index, 1);
  }
  watch(row, close) {
    const watcher = { close, timer: null };
    // Renewals reschedule; a long wait re-arms in chunks and rechecks the current expiry.
    watcher.schedule = () => {
      clearTimeout(watcher.timer);
      const remaining = row.expires - this.now();
      watcher.timer = setTimeout(
        () => (row.expires > this.now() ? watcher.schedule() : close()),
        Math.min(maxTimer, Math.max(0, remaining)),
      );
      watcher.timer.unref?.();
    };
    watcher.schedule();
    const watchers = this.watchers.get(row.hash) || new Set();
    watchers.add(watcher);
    this.watchers.set(row.hash, watchers);
    return () => {
      clearTimeout(watcher.timer);
      watchers.delete(watcher);
      if (!watchers.size) this.watchers.delete(row.hash);
    };
  }
}
