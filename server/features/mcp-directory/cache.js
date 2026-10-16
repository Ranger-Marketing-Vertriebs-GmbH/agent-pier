// Directory answers kept in memory only, per base URL and query; no disk, no prefetch.
export const ttl = {
  success: 60 * 60 * 1000,
  negative: 60 * 1000,
  health: 5 * 60 * 1000,
};

export const normaliseSearch = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 100);
export const searchKey = (base, search, cursor = "") =>
  JSON.stringify(["search", base, normaliseSearch(search), cursor]);
export const detailKey = (base, name) => JSON.stringify(["detail", base, name]);
export const healthKey = (base) => JSON.stringify(["health", base]);

export class TtlCache {
  constructor({ limit = 200, now = Date.now } = {}) {
    this.limit = limit;
    this.now = now;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expires) {
      this.entries.delete(key);
      return undefined;
    }
    // Map order is the use order: the oldest key leaves first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, lifetime) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + lifetime });
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  clear() {
    this.entries.clear();
  }
}
