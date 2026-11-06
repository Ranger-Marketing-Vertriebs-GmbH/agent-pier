export const EVENT_BUFFER_MS = 5000;
export const EXPECTATION_TTL_MS = 600000;
export const MAX_EXPECTATIONS = 32;
export const MAX_EVENTS = 32;

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

/**
 * The newest open expectation the event fits (latest `since`, the later one on a tie):
 * an event dated after two Enters belongs to the second, since the first had its
 * chance before.
 */
function newestFitting(list, event) {
  let match = null;
  for (const expectation of list)
    if (fits(expectation, event) && (!match || expectation.since >= match.since))
      match = expectation;
  return match;
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

  expect(sessionId, { deliveryId, since, imageNames }) {
    this.#prune(sessionId);
    const expectation = {
      deliveryId,
      since,
      imageNames: [...imageNames],
      expiresAt: this.#now() + EXPECTATION_TTL_MS,
    };
    // A retried delivery replaces its earlier expectation.
    const list = (this.#expectations.get(sessionId) ?? []).filter(
      (entry) => entry.deliveryId !== deliveryId,
    );
    const events = this.#events.get(sessionId) ?? [];
    const index = events.findIndex((entry) => fits(expectation, entry.event));
    if (index >= 0) {
      // The newest delivery takes the event, as in report().
      const [{ event }] = events.splice(index, 1);
      this.#retireOlder(sessionId, list, expectation);
      this.#emit(sessionId, deliveryId, outcomeOf(event));
      return;
    }
    list.push(expectation);
    while (list.length > MAX_EXPECTATIONS) list.shift();
    this.#expectations.set(sessionId, list);
  }

  report(sessionId, event) {
    this.#prune(sessionId);
    const list = this.#expectations.get(sessionId) ?? [];
    const match = newestFitting(list, event);
    if (match) {
      this.#retireOlder(
        sessionId,
        list.filter((entry) => entry !== match),
        match,
      );
      this.#emit(sessionId, match.deliveryId, outcomeOf(event));
      return;
    }
    if (list.length > 0) {
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
   * Keeps only the expectations newer than `match`. An older one that is still open
   * had no event of its own (a hook-blocked steer, a command without a submit event):
   * it stays handed-off, and the browser asks, instead of taking a later event.
   */
  #retireOlder(sessionId, list, match) {
    const kept = list.filter((entry) => entry.since > match.since);
    if (kept.length) this.#expectations.set(sessionId, kept);
    else this.#expectations.delete(sessionId);
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
