/**
 * Runs per-session file syncs one at a time, in call order, and coalesces full
 * passes: `coalesce(pass)` runs `pass` once after the tasks queued so far, and every
 * call made while it waits shares that one run. A failed task never blocks the next.
 */
export class SyncQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = null;
  }
  run(task) {
    const next = this.tail.catch(() => {}).then(task);
    this.tail = next;
    return next;
  }
  coalesce(pass) {
    this.pending ??= this.tail
      .catch(() => {})
      .then(() => {
        this.pending = null;
        return pass();
      });
    return this.pending;
  }
}
