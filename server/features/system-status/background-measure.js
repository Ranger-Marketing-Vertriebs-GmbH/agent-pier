/**
 * A slow measurement (data directory areas, cleanup summary) that runs in the
 * background when read and is cached for `maxAgeMs`. A read answers at once:
 * `pending` before the first result, `refreshing` with the previous result while a
 * newer one runs, `ready` otherwise. `invalidate` (after a deletion) measures again on
 * the next read, also when it comes during a measurement.
 */
export class BackgroundMeasure {
  constructor({ measure, maxAgeMs, now = Date.now, onError = () => {} }) {
    Object.assign(this, { measure, maxAgeMs, now, onError });
    this.value = null;
    this.measuredAt = 0;
    this.stale = false;
    this.run = null;
    this.closed = false;
  }
  read() {
    this.refresh();
    if (!this.value) return { state: "pending" };
    return { state: this.run ? "refreshing" : "ready", ...this.value };
  }
  refresh() {
    if (this.closed || this.run) return;
    if (this.value && !this.stale && this.now() - this.measuredAt < this.maxAgeMs) return;
    this.stale = false;
    this.run = Promise.resolve()
      .then(() => this.measure(() => this.closed))
      .then((value) => {
        if (this.closed) return;
        this.value = value;
        this.measuredAt = this.now();
      })
      .catch(this.onError)
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
