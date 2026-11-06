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
    const events = this.#events.get(sessionId) ?? [];
    const index = events.findIndex((entry) => fits(expectation, entry.event));
    if (index >= 0) {
      const [{ event }] = events.splice(index, 1);
      this.#emit(sessionId, deliveryId, outcomeOf(event));
      return;
    }
    const list = this.#expectations.get(sessionId) ?? [];
    list.push(expectation);
    while (list.length > MAX_EXPECTATIONS) list.shift();
    this.#expectations.set(sessionId, list);
  }

  report(sessionId, event) {
    this.#prune(sessionId);
    const list = this.#expectations.get(sessionId) ?? [];
    const index = list.findIndex((expectation) => fits(expectation, event));
    if (index >= 0) {
      const [expectation] = list.splice(index, 1);
      this.#emit(sessionId, expectation.deliveryId, outcomeOf(event));
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

  forget(sessionId) {
    this.#sources.delete(sessionId);
    this.#expectations.delete(sessionId);
    this.#events.delete(sessionId);
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
