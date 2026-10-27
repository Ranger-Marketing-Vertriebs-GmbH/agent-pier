/**
 * A slow measurement (data directory areas, cleanup summary) that runs in the
 * background when read and is cached for `maxAgeMs`. A read answers at once:
 * `pending` before the first result, `refreshing` with the previous result while a
 * newer one runs, `ready` otherwise, and `failed` when the last attempt failed and no
 * result is known. A failed attempt is retried after `retryMs`, never on every read.
 * `invalidate` (after a deletion) measures again on the next read, also when it comes
 * during a measurement. The measurement gets `isClosed()` to stop early at shutdown.
 */
export class BackgroundMeasure {
  constructor({
    measure,
    maxAgeMs,
    retryMs = Math.min(maxAgeMs, 60_000),
    now = Date.now,
    onError = () => {},
  }) {
    Object.assign(this, { measure, maxAgeMs, retryMs, now, onError });
    this.value = null;
    this.measuredAt = 0;
    this.failedAt = null;
    this.stale = false;
    this.run = null;
    this.closed = false;
  }
  read() {
    this.refresh();
    if (!this.value)
      return { state: !this.run && this.failedAt !== null ? "failed" : "pending" };
    return { state: this.run ? "refreshing" : "ready", ...this.value };
  }
  refresh() {
    if (this.closed || this.run) return;
    if (
      !this.stale &&
      this.failedAt !== null &&
      this.now() - this.failedAt < this.retryMs
    )
      return;
    if (this.value && !this.stale && this.now() - this.measuredAt < this.maxAgeMs) return;
    this.stale = false;
    this.run = Promise.resolve()
      .then(() => this.measure(() => this.closed))
      .then((value) => {
        if (this.closed) return;
        this.value = value;
        this.measuredAt = this.now();
        this.failedAt = null;
      })
      .catch((error) => {
        this.failedAt = this.now();
        this.onError(error);
      })
      .finally(() => {
        this.run = null;
      });
  }
  invalidate() {
    this.stale = true;
  }
  async close() {
    this.closed = true;
    await this.run;
  }
}
