/**
 * Ten password hashes per key and minute. Counting happens before any hash starts, so
 * parallel requests cannot slip past the limit.
 */
export class AttemptWindows {
  constructor({
    now = Date.now,
    limit = 10,
    limits = {},
    keep = [],
    duration = 60000,
    capacity = 1000,
  } = {}) {
    this.now = now;
    this.limit = limit;
    // Keys that pool many sources get their own, larger limit.
    this.limits = new Map(Object.entries(limits));
    // Pooled and kept keys are never evicted: a flood of fresh keys must not reset them.
    this.kept = new Set([...this.limits.keys(), ...keep]);
    this.duration = duration;
    this.capacity = capacity;
    this.windows = new Map();
  }
  /** Counts one attempt; false once the key has used up its window. */
  allow(key) {
    key = String(key ?? "");
    const now = this.now();
    const window = this.windows.get(key);
    const limit = this.limits.get(key) ?? this.limit;
    if (window && now - window.start < this.duration) return ++window.count <= limit;
    this.windows.delete(key);
    this.evict();
    this.windows.set(key, { start: now, count: 1 });
    return true;
  }
  // Bounded map: a flood of changing keys drops the oldest evictable window instead of
  // growing. The kept keys are few and fixed, so there is always one to drop.
  evict() {
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.capacity) return;
      if (!this.kept.has(key)) this.windows.delete(key);
    }
  }
}
