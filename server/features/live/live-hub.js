// The live hub: a registry of topics and their instances. A topic id is a name
// (`state`, `session.requests`) or `name:param`, split at the first colon. Each
// subscriber reaches the instance of its topic id and access scope (`scopeKey`), so
// recipients with equal keys share one read and different keys never share a
// payload. A topic the principal may not see resolves exactly like an unknown one.
import { randomUUID } from "node:crypto";
import { ChatSync } from "../chat/chat-sync.js";
import { LiveInstance } from "./live-instance.js";

export const MAX_TOPIC_ID = 200;
export const TOPIC_NAME = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/;
const MODES = new Set(["state", "rows", "signal"]);
// Revisions of topics nobody subscribes stay known for resubscribes, up to this many.
const MAX_RECORDS = 4096;

/** The frame for a topic id that does not resolve: unknown and denied look alike. */
export const unknownTopic = (topic) => ({ type: "error", topic, error: "unknown-topic" });

export class LiveHub {
  constructor({
    debounceMs = 150,
    maxWaitMs = 1000,
    timers = { setTimeout, clearTimeout },
    onError = () => {},
  } = {}) {
    Object.assign(this, { debounceMs, maxWaitMs, timers, onError });
    this.instance = randomUUID();
    this.sync = new ChatSync({});
    this.topics = new Map();
    this.instances = new Map();
    this.byName = new Map();
    this.records = new Map();
    // The highest revision issued: a fresh record starts above every earlier one, so
    // a revision is never reused for a topic id and scope, even after eviction.
    this.highest = 0;
    this.closed = false;
  }
  /** Registers a topic definition; a second definition of a name throws. */
  define(definition) {
    const { name, mode, param } = definition || {};
    if (typeof name !== "string" || !TOPIC_NAME.test(name))
      throw new Error(`Invalid live topic name: ${name}`);
    if (this.topics.has(name)) throw new Error(`Live topic ${name} is already defined`);
    if (!MODES.has(mode)) throw new Error(`Invalid live topic mode: ${mode}`);
    if (
      typeof definition.authorize !== "function" ||
      typeof definition.scopeKey !== "function"
    )
      throw new Error(`Live topic ${name} needs authorize and scopeKey`);
    if (mode !== "signal" && typeof definition.read !== "function")
      throw new Error(`Live topic ${name} needs read`);
    if (param !== undefined && !(param instanceof RegExp))
      throw new Error(`Live topic ${name} needs a RegExp param`);
    // The parameter must match whole; flags with state (g, y) are dropped.
    const pattern = param
      ? new RegExp(`^(?:${param.source})$`, param.flags.replace(/[gy]/g, ""))
      : null;
    this.topics.set(name, { definition, pattern });
  }
  /**
   * The definition and parameter of `topicId` for `principal`, or null when the id is
   * unknown, too long or malformed, or the principal may not see it.
   */
  resolve(principal, topicId) {
    if (typeof topicId !== "string" || !topicId || topicId.length > MAX_TOPIC_ID)
      return null;
    const colon = topicId.indexOf(":");
    const name = colon < 0 ? topicId : topicId.slice(0, colon);
    const param = colon < 0 ? undefined : topicId.slice(colon + 1);
    const topic = this.topics.get(name);
    if (!topic) return null;
    const { definition, pattern } = topic;
    if (
      param === undefined ? pattern && !definition.paramOptional : !pattern?.test(param)
    )
      return null;
    try {
      if (definition.authorize(principal, param) !== true) return null;
    } catch {
      return null;
    }
    return { definition, param };
  }
  /**
   * Subscribes `send` to `topicId`. `have` ({instance, revision} or {instance,
   * cursor}) is what the client holds; the first frame is `same`, `delta` or
   * `snapshot` against it. A topic that does not resolve gets `unknownTopic` and
   * nothing else. Returns the unsubscribe function.
   */
  subscribe(principal, topicId, have, send) {
    if (this.closed) throw new Error("The live hub is closed");
    const resolved = this.resolve(principal, topicId);
    let scopeKey;
    try {
      scopeKey = resolved && resolved.definition.scopeKey(principal, resolved.param);
    } catch {
      scopeKey = null;
    }
    if (typeof scopeKey !== "string") {
      send(unknownTopic(topicId));
      return () => {};
    }
    const key = JSON.stringify([topicId, scopeKey]);
    let instance = this.instances.get(key);
    if (!instance) instance = this.create(key, topicId, scopeKey, resolved);
    const subscriber = { principal, have: plainHave(have), send, key };
    instance.add(subscriber);
    return () => this.drop(instance, subscriber);
  }
  create(key, topicId, scopeKey, { definition, param }) {
    let record = this.records.get(key);
    if (record) this.records.delete(key);
    else record = { revision: this.highest, digest: undefined };
    // Most recently used last, so eviction takes the oldest.
    this.records.set(key, record);
    const instance = new LiveInstance({
      definition,
      topicId,
      param,
      scopeKey,
      instance: this.instance,
      sync: this.sync,
      record,
      onRevision: (revision) => (this.highest = Math.max(this.highest, revision)),
      debounceMs: this.debounceMs,
      maxWaitMs: this.maxWaitMs,
      timers: this.timers,
      onError: this.onError,
    });
    instance.key = key;
    this.instances.set(key, instance);
    if (!this.byName.has(definition.name)) this.byName.set(definition.name, new Set());
    this.byName.get(definition.name).add(instance);
    return instance;
  }
  drop(instance, subscriber) {
    instance.remove(subscriber);
    if (instance.size || this.instances.get(instance.key) !== instance) return;
    this.instances.delete(instance.key);
    const named = this.byName.get(instance.definition.name);
    named?.delete(instance);
    if (named && !named.size) this.byName.delete(instance.definition.name);
    for (const [key] of this.records) {
      if (this.records.size <= MAX_RECORDS) break;
      if (!this.instances.has(key)) this.records.delete(key);
    }
  }
  /** Instances of `name`, all of them or only those of `param`. */
  named(name, param) {
    return [...(this.byName.get(name) || [])].filter(
      (instance) => param === undefined || instance.param === param,
    );
  }
  /** `name` (or `name:param`) changed: recompute and push where someone subscribes. */
  invalidate(name, param) {
    for (const instance of this.named(name, param)) instance.invalidate();
  }
  /** A sampled source of `name` may have changed: sample it before the next tick. */
  nudge(name, param) {
    for (const instance of this.named(name, param)) instance.nudge();
  }
  /**
   * Checks every subscription again (after a privacy or account change): one that no
   * longer passes `authorize`, or whose scope changed, gets `revoked` and is dropped.
   */
  reauthorize() {
    for (const instance of [...this.instances.values()])
      for (const subscriber of [...instance.subscribers]) {
        const { definition, param } = instance;
        let allowed = false;
        try {
          allowed =
            definition.authorize(subscriber.principal, param) === true &&
            definition.scopeKey(subscriber.principal, param) === instance.scopeKey;
        } catch {
          allowed = false;
        }
        if (allowed) continue;
        this.drop(instance, subscriber);
        subscriber.send({ type: "revoked", topic: instance.topicId });
      }
  }
  close() {
    this.closed = true;
    for (const instance of this.instances.values()) instance.stop();
    this.instances.clear();
    this.byName.clear();
  }
}

/** Only the fields the hub compares, so a client object cannot carry anything else. */
function plainHave(have) {
  if (!have || typeof have !== "object") return undefined;
  const { instance, revision, cursor } = have;
  return {
    instance: typeof instance === "string" ? instance : undefined,
    revision: Number.isSafeInteger(revision) ? revision : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
  };
}
