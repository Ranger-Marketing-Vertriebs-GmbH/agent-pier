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
  limitOf(key) {
    return this.limits.get(key) ?? this.limit;
  }
  active(window, now = this.now()) {
    return Boolean(window) && now - window.start < this.duration;
  }
  /** Whether one more attempt fits the key's window, without counting it. */
  allows(key) {
    const window = this.windows.get(String(key ?? ""));
    return !this.active(window) || window.count < this.limitOf(String(key ?? ""));
  }
  /** Counts one attempt; false once the key has used up its window. */
  allow(key) {
    key = String(key ?? "");
    const now = this.now();
    const window = this.windows.get(key);
    if (this.active(window, now)) return ++window.count <= this.limitOf(key);
    this.windows.delete(key);
    this.evict(now);
    this.windows.set(key, { start: now, count: 1 });
    return true;
  }
  /** Counts one attempt against every key, or none when any of them refuses. */
  allowAll(keys) {
    keys = [keys].flat();
    if (!keys.every((key) => this.allows(key))) return false;
    for (const key of keys) this.allow(key);
    return true;
  }
  // Bounded map: a flood of changing keys drops expired windows first, then the oldest
  // window that still has attempts left. A kept or used-up window is never dropped,
  // since dropping it would hand its source a fresh set of guesses. Each used-up window
  // cost its source a full set of hashes, so the map can only outgrow the bound as fast
  // as passwords are hashed, and expired windows leave it again.
  evict(now) {
    if (this.windows.size < this.capacity) return;
    for (const [key, window] of this.windows)
      if (!this.active(window, now)) this.windows.delete(key);
    for (const [key, window] of this.windows) {
      if (this.windows.size < this.capacity) return;
      if (!this.kept.has(key) && window.count < this.limitOf(key))
        this.windows.delete(key);
    }
  }
}
