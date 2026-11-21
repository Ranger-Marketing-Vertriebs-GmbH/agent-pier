import { createHash } from "node:crypto";

/** Deliveries whose Enter lies this close before an event are candidates for it. */
export const ASK_WINDOW_MS = 8000;
export const EVENT_BUFFER_MS = 5000;
export const EXPECTATION_TTL_MS = 600000;
export const MAX_EXPECTATIONS = 32;
export const MAX_EVENTS = 32;

/**
 * A prompt's identity by text, blind to whitespace the TUI may change (line endings,
 * a trailing newline, indentation of a paste): a sha256 hex digest, so an event
 * carries no prompt text.
 */
export function promptTextHash(text) {
  if (typeof text !== "string") return undefined;
  return createHash("sha256").update(text.replace(/\s+/g, "")).digest("hex");
}

function sameNames(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((name, index) => name === b[index]);
}

function fits(expectation, event) {
  if (event.at < expectation.since) return false;
  if (event.imageCount !== expectation.imageNames.length) return false;
  return event.imageNames === null || sameNames(event.imageNames, expectation.imageNames);
}

function isFresh(expectation, event) {
  return expectation.since >= event.at - ASK_WINDOW_MS;
}

/**
 * The expectation an event names by its text (Codex reports the text the TUI sent):
 * among the fitting ones, those with the same text hash. When they are exactly one,
 * the event is that delivery's, whatever its time; when none, the text tells nothing
 * (an image placeholder, a TUI rewrite) and time decides as below.
 */
function named(list, event) {
  if (!event.textHash) return [];
  return list.filter((entry) => fits(entry, event) && entry.textHash === event.textHash);
}

/**
 * The newest open expectation the event fits (latest `since`, the later one on a tie):
 * an event dated after two Enters belongs to the second, since the first had its
 * chance before. When the event fits two or more fresh expectations (Enter within
 * ASK_WINDOW_MS before the event), it cannot be told apart and confirms none.
 * Tombstones of deliveries retired as ambiguous still count as fresh fits, so their
 * own late events cannot confirm another delivery, but are never the newest.
 */
function resolve(list, event) {
  const byText = named(list, event);
  if (byText.length === 1)
    return byText[0].tombstone
      ? { newest: null, retired: true, ambiguous: false }
      : { newest: byText[0], ambiguous: false };
  // Two with the same text: only those can be the event's, by time as below.
  if (byText.length > 1) list = byText;
  let newest = null;
  let fresh = 0;
  for (const expectation of list) {
    if (!fits(expectation, event)) continue;
    if (isFresh(expectation, event)) fresh += 1;
    if (expectation.tombstone) continue;
    if (!newest || expectation.since >= newest.since) newest = expectation;
  }
  return { newest, retired: !newest && byText.length > 1, ambiguous: fresh > 1 };
}

/** Caps the list, evicting tombstones before open expectations. */
function cap(list) {
  while (list.length > MAX_EXPECTATIONS) {
    const index = list.findIndex((entry) => entry.tombstone);
    list.splice(Math.max(index, 0), 1);
  }
}

function outcomeOf(event) {
  const outcome = { kind: event.kind };
  if (event.queued !== undefined) outcome.queued = event.queued;
  if (event.reason !== undefined) outcome.reason = event.reason;
  return outcome;
}

export class DeliveryAcceptance {
  #now;
  #onMatch;
  #sources = new Map();
  #expectations = new Map();
  #events = new Map();

  constructor({ now = Date.now, onMatch } = {}) {
    this.#now = now;
    this.#onMatch = onMatch;
  }

  ready(sessionId, source) {
    this.#sources.set(sessionId, source);
  }

  supports(sessionId) {
    return this.#sources.has(sessionId);
  }

  /** `text`, the delivered text, is kept only as its hash (promptTextHash). */
  expect(sessionId, { deliveryId, since, imageNames, text }) {
    this.#prune(sessionId);
    const textHash = promptTextHash(text);
    const expectation = {
      deliveryId,
      since,
      imageNames: [...imageNames],
      ...(textHash ? { textHash } : {}),
      expiresAt: this.#now() + EXPECTATION_TTL_MS,
    };
    // A retried delivery replaces its earlier expectation.
    const list = (this.#expectations.get(sessionId) ?? []).filter(
      (entry) => entry.deliveryId !== deliveryId,
    );
    list.push(expectation);
    const events = this.#events.get(sessionId) ?? [];
    const index = events.findIndex((entry) => fits(expectation, entry.event));
    if (index >= 0) {
      // A buffered event settles as in report().
      const [{ event }] = events.splice(index, 1);
      this.#settle(sessionId, list, event);
      return;
    }
    cap(list);
    this.#expectations.set(sessionId, list);
  }

  report(sessionId, event) {
    this.#prune(sessionId);
    const list = this.#expectations.get(sessionId) ?? [];
    if (this.#settle(sessionId, list, event)) return;
    if (list.some((entry) => !entry.tombstone)) {
      // Fits no open expectation: the owner's own prompt.
      return;
    }
    const events = this.#events.get(sessionId) ?? [];
    events.push({ event, expiresAt: this.#now() + EVENT_BUFFER_MS });
    while (events.length > MAX_EVENTS) events.shift();
    this.#events.set(sessionId, events);
  }

  /** Enter was never sent for this delivery: its expectation must not match. */
  withdraw(sessionId, deliveryId) {
    const list = this.#expectations.get(sessionId);
    if (!list) return;
    const kept = list.filter((entry) => entry.deliveryId !== deliveryId);
    if (kept.length) this.#expectations.set(sessionId, kept);
    else this.#expectations.delete(sessionId);
  }

  forget(sessionId) {
    this.#sources.delete(sessionId);
    this.#expectations.delete(sessionId);
    this.#events.delete(sessionId);
  }

  /**
   * Gives the event to the newest fitting expectation and keeps only the newer ones.
   * An older one that is still open had no event of its own (a hook-blocked steer, a
   * command without a submit event): it stays handed-off, and the browser asks,
   * instead of taking a later event. An ambiguous event retires the newest fitting
   * one too and confirms none, so all of them ask; the fresh fitting ones stay as
   * tombstones until the ask window after their Enter ends. Returns whether the event
   * fit.
   */
  #settle(sessionId, list, event) {
    const { newest, retired, ambiguous } = resolve(list, event);
    // The late event of a delivery retired as ambiguous: it confirms nobody.
    if (retired) return true;
    if (!newest) return false;
    // Newer: a later Enter, or the same moment and registered later (as in resolve).
    const at = list.indexOf(newest);
    const newer = (entry, index) =>
      entry.since > newest.since || (entry.since === newest.since && index > at);
    const kept = list.filter(newer);
    if (ambiguous) {
      const tombstones = list
        .filter((entry, index) => !newer(entry, index))
        .filter((entry) => fits(entry, event) && isFresh(entry, event))
        .map(({ since, imageNames, textHash }) => ({
          since,
          imageNames,
          ...(textHash ? { textHash } : {}),
          tombstone: true,
          expiresAt: since + ASK_WINDOW_MS,
        }));
      kept.unshift(...tombstones);
      cap(kept);
    }
    if (kept.length) this.#expectations.set(sessionId, kept);
    else this.#expectations.delete(sessionId);
    if (!ambiguous) this.#emit(sessionId, newest.deliveryId, outcomeOf(event));
    return true;
  }

  #prune(sessionId) {
    const now = this.#now();
    const list = this.#expectations.get(sessionId);
    if (list) {
      const kept = list.filter((entry) => entry.expiresAt > now);
      if (kept.length) this.#expectations.set(sessionId, kept);
      else this.#expectations.delete(sessionId);
    }
    const events = this.#events.get(sessionId);
    if (events) {
      const kept = events.filter((entry) => entry.expiresAt > now);
      if (kept.length) this.#events.set(sessionId, kept);
      else this.#events.delete(sessionId);
    }
  }

  #emit(sessionId, deliveryId, outcome) {
    try {
      this.#onMatch?.(sessionId, deliveryId, outcome);
    } catch {
      console.error("AgentPier could not report a delivery acceptance.");
    }
  }
}
