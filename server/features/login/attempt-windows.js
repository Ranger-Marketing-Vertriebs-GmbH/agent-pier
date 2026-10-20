/**
 * Ten password hashes per key and minute. Counting happens before any hash starts, so
 * parallel requests cannot slip past the limit.
 */
export class AttemptWindows {
  constructor({ now = Date.now, limit = 10, duration = 60000 } = {}) {
    this.now = now;
    this.limit = limit;
    this.duration = duration;
    this.windows = new Map();
  }
  /** Counts one attempt; false once the key has used up its window. */
  allow(key) {
    key = String(key ?? "");
    const now = this.now();
    const window = this.windows.get(key);
    if (window && now - window.start < this.duration) return ++window.count <= this.limit;
    this.windows.delete(key);
    // Bounded map: a flood of changing keys drops the oldest window instead of growing.
    while (this.windows.size >= 1000)
      this.windows.delete(this.windows.keys().next().value);
    this.windows.set(key, { start: now, count: 1 });
    return true;
  }
}
