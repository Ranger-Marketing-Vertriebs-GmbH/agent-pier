// One live topic instance: a topic id for one access scope, alive while someone
// subscribes. It reads the topic once for all its subscribers, coalesces change
// signals (trailing debounce, maxWait, and a running/again loop so the last change
// always gets a read), raises its revision only when the digest changes, and sends
// each subscriber the frame its mode asks for. Samplers and change sources run only
// while the instance has subscribers.
import { LIST_CURSOR, digestOf, listRows } from "./live-rows.js";

export const DEFAULT_MAX_BYTES = 262144;

// Frames shared by several subscribers are measured once.
const sizes = new WeakMap();
const frameBytes = (frame) => {
  if (!sizes.has(frame)) sizes.set(frame, Buffer.byteLength(JSON.stringify(frame)));
  return sizes.get(frame);
};

export class LiveInstance {
  /**
   * `instance`: the hub's process id; `sync`: the hub's ChatSync; `record`
   * ({revision, digest}) outlives the instance so a resubscribe can answer `same`;
   * `onRevision(revision)` reports every revision issued.
   */
  constructor({
    definition,
    topicId,
    param,
    scopeKey,
    instance,
    sync,
    record = { revision: 0, digest: undefined },
    onRevision = () => {},
    debounceMs = 150,
    maxWaitMs = 1000,
    timers = { setTimeout, clearTimeout },
    onError = () => {},
  }) {
    Object.assign(this, { definition, topicId, param, scopeKey, instance, sync });
    Object.assign(this, { record, onRevision, debounceMs, maxWaitMs, timers, onError });
    this.mode = definition.mode;
    this.maxBytes = definition.maxBytes ?? DEFAULT_MAX_BYTES;
    this.subscribers = new Set();
    this.value = undefined;
    this.settled = false;
    this.dirty = false;
    this.sampleDue = false;
    this.running = false;
    this.closed = false;
  }
  get revision() {
    return this.record.revision;
  }
  get size() {
    return this.subscribers.size;
  }
  /**
   * Adds `{principal, have, send}`. The first subscriber starts the change sources
   * and the first read; later ones are answered from the settled value at once.
   */
  add(subscriber) {
    if (this.closed) throw new Error("The live topic instance is closed");
    subscriber.waiting = true;
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) this.start();
    if (this.mode === "signal" || this.settled) this.answer(subscriber);
  }
  /** Removes a subscriber; the last one stops the change sources and the sampler. */
  remove(subscriber) {
    if (!this.subscribers.delete(subscriber)) return;
    const { cursor } = subscriber;
    // A reconnecting tab resumes from its cursor; a shared one stays active.
    if (cursor && ![...this.subscribers].some((other) => other.cursor === cursor))
      this.sync.park(cursor);
    if (!this.subscribers.size) this.stop();
  }
  start() {
    this.closed = false;
    try {
      this.unwatch = this.definition.watch?.({
        param: this.param,
        invalidate: () => this.invalidate(),
        nudge: () => this.nudge(),
      });
    } catch (error) {
      this.report(error);
    }
    if (this.mode === "signal") return;
    this.dirty = true;
    this.flush();
  }
  stop() {
    this.closed = true;
    this.clearTimers();
    this.timers.clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
    const unwatch = this.unwatch;
    this.unwatch = null;
    this.subscribers.clear();
    try {
      if (typeof unwatch === "function") unwatch();
    } catch (error) {
      this.report(error);
    }
  }
  /** The topic changed: read it again (coalesced; nothing without subscribers). */
  invalidate() {
    if (this.closed || !this.subscribers.size) return;
    this.dirty = true;
    this.schedule();
  }
  /** The sampled source may have changed: sample before the next tick (coalesced). */
  nudge() {
    if (this.closed || !this.subscribers.size) return;
    this.sampleDue = true;
    this.schedule();
  }
  schedule() {
    // A running read schedules again when it finishes.
    if (this.running) return;
    this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => this.flush(), this.debounceMs);
    this.debounce?.unref?.();
    if (!this.deadline) {
      this.deadline = this.timers.setTimeout(() => this.flush(), this.maxWaitMs);
      this.deadline?.unref?.();
    }
  }
  clearTimers() {
    this.timers.clearTimeout(this.debounce);
    this.timers.clearTimeout(this.deadline);
    this.debounce = this.deadline = null;
  }
  arm() {
    const { sampleMs } = this.definition;
    if (!sampleMs || this.closed) return;
    this.timers.clearTimeout(this.sampleTimer);
    this.sampleTimer = this.timers.setTimeout(() => {
      this.sampleTimer = null;
      this.sampleDue = true;
      this.flush();
    }, sampleMs);
    this.sampleTimer?.unref?.();
  }
  flush() {
    this.clearTimers();
    if (this.running || this.closed || !this.subscribers.size) return;
    this.timers.clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
    this.running = true;
    this.cycle()
      .catch((error) => this.report(error))
      .finally(() => {
        this.running = false;
        if (this.closed || !this.subscribers.size) return;
        if (this.dirty || this.sampleDue) this.schedule();
        else this.arm();
      });
  }
  async cycle() {
    const forced = this.dirty;
    this.dirty = this.sampleDue = false;
    if (this.mode === "signal") {
      this.raise();
      for (const subscriber of [...this.subscribers])
        subscriber.send({
          type: "changed",
          topic: this.topicId,
          revision: this.revision,
        });
      return;
    }
    if (!forced && this.definition.sampling) {
      let sampling = false;
      try {
        sampling = await this.definition.sampling(this.param);
      } catch (error) {
        this.report(error);
      }
      if (!sampling) return;
    }
    const [reader] = this.subscribers;
    let value;
    try {
      value = await this.definition.read(reader.principal, this.param);
    } catch (error) {
      this.report(error);
      if (this.closed) return;
      for (const subscriber of [...this.subscribers])
        if (subscriber.waiting) subscriber.send({ type: "error", topic: this.topicId });
      return;
    }
    if (this.closed) return;
    const digest = digestOf(
      this.definition.digest ? this.definition.digest(value) : value,
    );
    const changed = digest !== this.record.digest;
    this.value = value;
    this.rows = this.mode === "rows" ? listRows(value) : undefined;
    this.settled = true;
    if (changed) {
      this.record.digest = digest;
      this.raise();
    }
    const encoded = new Map();
    for (const subscriber of [...this.subscribers])
      if (subscriber.waiting) this.answer(subscriber, encoded);
      else if (changed) this.push(subscriber, encoded);
  }
  raise() {
    this.record.revision += 1;
    this.onRevision(this.record.revision);
  }
  /** The first frame for a subscriber, measured against what it says it holds. */
  answer(subscriber, encoded = new Map()) {
    subscriber.waiting = false;
    const { have } = subscriber;
    const current = have?.instance === this.instance;
    const same = { type: "same", topic: this.topicId, revision: this.revision };
    if (this.mode === "signal") {
      const known = !have || (current && have.revision === this.revision);
      subscriber.send(known ? same : { ...same, type: "changed" });
    } else if (this.mode === "state") {
      if (current && have.revision === this.revision) subscriber.send(same);
      else this.deliver(subscriber, { ...same, type: "snapshot", data: this.value });
    } else {
      const cursor =
        current && LIST_CURSOR.test(String(have.cursor ?? "")) ? have.cursor : undefined;
      subscriber.cursor = cursor;
      this.pushRows(subscriber, encoded, true);
    }
  }
  /** A change for a subscriber that already holds an earlier revision. */
  push(subscriber, encoded) {
    if (this.mode === "rows") return this.pushRows(subscriber, encoded, false);
    if (!encoded.has(null))
      encoded.set(null, {
        type: "state",
        topic: this.topicId,
        revision: this.revision,
        data: this.value,
      });
    this.deliver(subscriber, encoded.get(null));
  }
  /** Encodes once per distinct cursor: subscribers on one baseline share a frame. */
  pushRows(subscriber, encoded, first) {
    const key = subscriber.cursor || "";
    if (!encoded.has(key)) {
      const data = this.sync.encodeScoped(
        [this.topicId, this.scopeKey],
        this.rows,
        subscriber.cursor,
      );
      const { mode, base, cursor } = data.sync;
      const frame = { topic: this.topicId, revision: this.revision };
      // A delta onto an equal baseline (a parked cursor after a resubscribe gets a
      // new one) carries no difference: the subscriber keeps its own cursor.
      const same =
        mode === "delta" && (base === cursor || this.sync.sameBaseline(base, cursor));
      encoded.set(key, {
        cursor: same ? base : cursor,
        frame: same
          ? { type: "same", ...frame }
          : { type: mode === "delta" ? "delta" : "snapshot", ...frame, data },
      });
    }
    const { cursor, frame } = encoded.get(key);
    subscriber.cursor = cursor || undefined;
    if (frame.type !== "same") this.deliver(subscriber, frame);
    else if (first) subscriber.send(frame);
  }
  /** Sends `frame`, or `stale` when it is over the topic's `maxBytes`. */
  deliver(subscriber, frame) {
    if (frameBytes(frame) <= this.maxBytes) return subscriber.send(frame);
    // The client refetches over REST; its cursor no longer matches any frame it got.
    if (this.mode === "rows") subscriber.cursor = undefined;
    subscriber.send({ type: "stale", topic: frame.topic, revision: frame.revision });
  }
  report(error) {
    try {
      this.onError(error, { topic: this.topicId });
    } catch {
      // A failing error reporter must not stop the instance.
    }
  }
}
