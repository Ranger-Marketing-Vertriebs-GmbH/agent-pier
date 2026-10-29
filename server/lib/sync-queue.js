/**
 * Runs per-session file syncs one at a time, in call order, and coalesces full
 * passes: `coalesce(pass, key)` runs `pass` once after the tasks queued so far, and
 * every call with the same key made while it waits shares that one run. A call made
 * while that pass already runs gets a new pass after it, and passes of other keys (the
 * sessions' and the agents' on one shared queue) never share a run. A failed task
 * never blocks the next.
 */
export class SyncQueue {
  constructor() {
    this.tail = Promise.resolve();
    // key -> the pass that has not started yet.
    this.pending = new Map();
  }
  run(task) {
    const next = this.tail.catch(() => {}).then(() => task());
    this.tail = next;
    return next;
  }
  /** Resolves once every task queued so far has settled. */
  idle() {
    return this.tail.then(
      () => {},
      () => {},
    );
  }
  coalesce(pass, key = "") {
    if (!this.pending.has(key))
      this.pending.set(
        key,
        this.tail
          .catch(() => {})
          .then(() => {
            this.pending.delete(key);
            return pass();
          }),
      );
    return this.pending.get(key);
  }
}
