import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { collectItems } from "./inbox-sources.js";
import { countItems, itemsSignature, sortItems } from "./inbox-items.js";
import { itemHistory } from "./inbox-history.js";

// Reports a source that cannot be read once per process; the other sources still show.
function reportOnce() {
  const reported = new Set();
  return (error, source = "inbox") => {
    if (reported.has(source)) return;
    reported.add(source);
    console.error(
      `AgentPier could not read ${source} for the inbox: ${error?.code || "unknown error"}`,
    );
  };
}

/**
 * Everything waiting for the owner, merged from the native CLI requests, pipeline
 * gates, agent approvals and team proposals. The inbox only reads: answers go through
 * each source's own endpoint. Every change of the waiting set raises the revision and
 * is pushed to subscribers as counts and revision; clients then read the list again.
 * Sources announce changes through changed(); a timer catches what they do not
 * announce (expiry, a request's delivery state) while anyone listens.
 */
export class OwnerInbox {
  constructor({
    services,
    now = Date.now,
    intervalMs = 2000,
    debounceMs = 100,
    maxAgeMs = 1000,
    onError = reportOnce(),
  }) {
    Object.assign(this, { services, now, intervalMs, debounceMs, maxAgeMs, onError });
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    // Revisions count from one per process; the instance tells clients a restart
    // started a new count.
    this.instance = randomUUID();
    this.revision = 0;
    this.signature = null;
    this.current = null;
    this.computedAt = 0;
    this.dirty = true;
    this.watchAssistants();
  }
  /** The agent service can be created and replaced at runtime; follow the current one. */
  watchAssistants() {
    const events = this.services.assistants?.events;
    if (events === this.assistantEvents) return;
    this.unwatch?.();
    this.assistantEvents = events;
    this.unwatch = events?.subscribe
      ? events.subscribe((event) => {
          if (event?.type === "change") this.changed();
        })
      : null;
  }
  /** A source changed: recompute soon when someone listens, else on the next read. */
  changed() {
    this.dirty = true;
    if (this.closed || !this.events.listenerCount("change") || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.refresh().catch((error) => this.onError(error));
    }, this.debounceMs);
    this.debounce.unref?.();
  }
  async snapshot() {
    // A read during a computation shares it; only a change asks for another one.
    if (this.running) return this.running;
    if (this.current && !this.dirty && this.now() - this.computedAt < this.maxAgeMs)
      return this.current;
    return this.refresh();
  }
  async summary() {
    const { instance, revision, counts } = await this.snapshot();
    return { instance, revision, counts };
  }
  refresh() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.dirty = false;
        await this.compute();
      } while (this.again && !this.closed);
      return this.current;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async compute() {
    this.watchAssistants();
    const now = this.now();
    const items = sortItems(
      await collectItems(this.services, {
        now,
        onError: (source, error) => this.onError(error, source),
      }),
      now,
    );
    const signature = itemsSignature(items);
    const changed = signature !== this.signature;
    if (changed) {
      this.revision++;
      this.signature = signature;
    }
    this.current = {
      instance: this.instance,
      revision: this.revision,
      counts: countItems(items),
      items,
    };
    this.computedAt = now;
    if (changed)
      this.events.emit("change", {
        type: "inbox",
        instance: this.instance,
        revision: this.current.revision,
        counts: this.current.counts,
      });
  }
  /** Calls `listener(event)` on every change; the timer runs while anyone listens. */
  subscribe(listener) {
    this.events.on("change", listener);
    if (!this.timer && this.intervalMs > 0) {
      this.timer = setInterval(
        () => this.refresh().catch((error) => this.onError(error)),
        this.intervalMs,
      );
      this.timer.unref?.();
    }
    return () => {
      this.events.off("change", listener);
      if (!this.events.listenerCount("change")) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
  /**
   * One item by its stable address: still waiting, recently done (from the audit log,
   * for a day), or no longer waiting.
   */
  async status(type, id) {
    const { items } = await this.snapshot();
    const item = items.find((i) => i.type === type && i.id === id);
    if (item) return { state: "pending", item };
    return itemHistory(this.services.audit, type, id, this.now());
  }
  close() {
    this.closed = true;
    clearTimeout(this.debounce);
    clearInterval(this.timer);
    this.timer = null;
    this.unwatch?.();
    this.events.emit("close");
    this.events.removeAllListeners();
  }
}
