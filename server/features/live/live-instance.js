// One live topic instance: a topic id for one access scope, alive while someone
// subscribes. It reads the topic once for all its subscribers, coalesces change
// signals (trailing debounce, maxWait, and a running/again loop so the last change
// always gets a read), raises its revision only when the digest changes, and sends
// each subscriber the frame its mode asks for. Samplers and change sources run only
// while the instance has subscribers.
import { LIST_CURSOR, digestOf, listRows } from "./live-rows.js";
import { readStamp } from "../../lib/read-stamp.js";

export const DEFAULT_MAX_BYTES = 262144;
// A subscriber hears at most one `stale` per window: a value that stays over its
// topic's limit would otherwise send its tab to the REST route on every change. A
// stale due within the window is sent once at its end, unless a frame that fits
// was delivered meanwhile.
export const STALE_QUIET_MS = 10000;

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
    // Whether the last read failed.
    this.failed = false;
    this.dirty = false;
    this.sampleDue = false;
    this.running = false;
    this.closed = false;
    // Raised by reset(): a read that began before it is discarded.
    this.generation = 0;
    this.urgent = false;
  }
  get revision() {
    return this.record.revision;
  }
  get size() {
    return this.subscribers.size;
  }
  /**
   * Adds `{principal, have, send}`. The first subscriber starts the change sources
   * and the first read; later ones are answered from the settled value at once,
   * unless the last read failed: then a new read answers them.
   */
  add(subscriber) {
    if (this.closed) throw new Error("The live topic instance is closed");
    subscriber.waiting = true;
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) this.start();
    // The last read failed (agents off, say): the stored value may be gone, so read
    // again and answer this subscriber with that read, never with the stored value.
    if (this.mode !== "signal" && this.failed) this.invalidate();
    else if (this.mode === "signal" || this.settled) this.answer(subscriber);
  }
  /** Removes a subscriber; the last one stops the change sources and the sampler. */
  remove(subscriber) {
    if (!this.subscribers.delete(subscriber)) return;
    this.timers.clearTimeout(subscriber.staleQuiet);
    subscriber.staleQuiet = subscriber.stalePending = undefined;
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
    if (this.mode === "signal") {
      // A change while nobody subscribed sent nothing and left no trace: a record
      // carried over from an earlier instance rises once, so a client holding its
      // revision refetches (at most one extra GET) instead of hearing `same`.
      if (this.record.started) this.raise();
      this.record.started = true;
      return;
    }
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
  /**
   * The access behind the value changed: forget it, discard what each subscriber's
   * connection still holds back, and read again now. Every subscriber is answered
   * afresh (a snapshot), as if it had just joined.
   */
  reset() {
    this.generation += 1;
    this.value = this.rows = this.readAt = undefined;
    this.settled = false;
    this.record.digest = undefined;
    if (this.closed || !this.subscribers.size) return;
    for (const subscriber of this.subscribers) {
      subscriber.discard?.();
      // Its answer goes out at once, never held back by an earlier `stale`'s window.
      this.timers.clearTimeout(subscriber.staleQuiet);
      subscriber.staleQuiet = subscriber.stalePending = undefined;
      subscriber.waiting = true;
      subscriber.failed = false;
      subscriber.have = subscriber.cursor = undefined;
    }
    this.dirty = true;
    if (this.running) this.urgent = true;
    else this.flush();
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
        if (this.urgent) {
          this.urgent = false;
          this.flush();
        } else if (this.dirty || this.sampleDue) this.schedule();
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
      if (!sampling || this.closed) return;
    }
    const [reader] = this.subscribers;
    const generation = this.generation;
    // When this read began: a browser keeps a REST answer read later than it. A read
    // that answers from data read earlier (a cached sample) dates it back with
    // `basedOn(stamp)`.
    let readAt = readStamp();
    const context = {
      basedOn: (stamp) => {
        if (Number.isSafeInteger(stamp) && stamp < readAt) readAt = stamp;
      },
    };
    let value;
    try {
      value = await this.definition.read(reader.principal, this.param, context);
    } catch (error) {
      if (generation !== this.generation) return;
      this.failed = true;
      // The value a subscriber holds may be gone (a project deregistered): the read
      // that succeeds again is pushed, even if it equals the last one.
      this.record.digest = undefined;
      this.report(error);
      if (this.closed) return;
      // Once per subscriber and failure: it reads the REST route, which shows the
      // refusal, and a later read answers it.
      for (const subscriber of [...this.subscribers])
        if (!subscriber.failed) {
          subscriber.failed = true;
          subscriber.send({ type: "error", topic: this.topicId });
        }
      return;
    }
    // Read before a reset: the access it was read under is gone.
    if (this.closed || generation !== this.generation) return;
    this.failed = false;
    for (const subscriber of this.subscribers) subscriber.failed = false;
    const digest = digestOf(
      this.definition.digest ? this.definition.digest(value) : value,
    );
    const changed = digest !== this.record.digest;
    this.value = value;
    this.readAt = readAt;
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
      else
        this.deliver(subscriber, {
          ...same,
          type: "snapshot",
          readAt: this.readAt,
          data: this.sent(),
        });
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
        readAt: this.readAt,
        data: this.sent(),
      });
    this.deliver(subscriber, encoded.get(null));
  }
  /**
   * The value of a `state` frame as it leaves now: a topic's `stamp(value)` may add
   * what depends on the moment of sending (a cached value answers late subscribers).
   */
  sent() {
    return this.definition.stamp ? this.definition.stamp(this.value) : this.value;
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
      const frame = { topic: this.topicId, revision: this.revision, readAt: this.readAt };
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
  /**
   * Sends `frame`, or `stale` when it is over the topic's `maxBytes`. A rows
   * subscriber that got `stale` holds no baseline, so its next frame is a snapshot:
   * once one fits again, it is back on deltas.
   */
  deliver(subscriber, frame) {
    if (frameBytes(frame) <= this.maxBytes) {
      subscriber.stalePending = false;
      return subscriber.send(frame);
    }
    // The client refetches over REST; its cursor no longer matches any frame it got.
    if (this.mode === "rows") subscriber.cursor = undefined;
    this.stale(subscriber);
  }
  /** `stale` for `subscriber`, at most once per STALE_QUIET_MS (see there). */
  stale(subscriber) {
    if (subscriber.staleQuiet) {
      subscriber.stalePending = true;
      return;
    }
    subscriber.send({ type: "stale", topic: this.topicId, revision: this.revision });
    subscriber.staleQuiet = this.timers.setTimeout(() => {
      subscriber.staleQuiet = undefined;
      const due = subscriber.stalePending;
      subscriber.stalePending = false;
      if (due && !this.closed && this.subscribers.has(subscriber)) this.stale(subscriber);
    }, STALE_QUIET_MS);
    subscriber.staleQuiet.unref?.();
  }
  report(error) {
    try {
      this.onError(error, { topic: this.topicId });
    } catch {
      // A failing error reporter must not stop the instance.
    }
  }
}
