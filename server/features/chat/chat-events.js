/**
 * Lightweight, session-scoped hints for chat stream subscribers. Transcript
 * data stays in ChatStore; reconnects reconcile through the HTTP snapshot.
 */
export class ChatEvents {
  constructor({ maxEvents = 128 } = {}) {
    this.maxEvents = maxEvents;
    this.sequence = new Map();
    this.history = new Map();
    this.subscribers = new Map();
  }
  publish(sessionId, type = "changed", details = {}) {
    const sequence = (this.sequence.get(sessionId) || 0) + 1;
    this.sequence.set(sessionId, sequence);
    const event = { type, sessionId, sequence, ...details };
    const rows = this.history.get(sessionId) || [];
    rows.push(event);
    while (rows.length > this.maxEvents) rows.shift();
    this.history.set(sessionId, rows);
    for (const subscriber of this.subscribers.get(sessionId) || []) subscriber(event);
    return event;
  }
  since(sessionId, sequence = 0) {
    const rows = this.history.get(sessionId) || [];
    if (!rows.length) return [];
    if (sequence < rows[0].sequence - 1) return null;
    return rows.filter((event) => event.sequence > sequence);
  }
  subscribe(sessionId, subscriber) {
    let rows = this.subscribers.get(sessionId);
    if (!rows) this.subscribers.set(sessionId, (rows = new Set()));
    rows.add(subscriber);
    return () => {
      rows.delete(subscriber);
      if (!rows.size) this.subscribers.delete(sessionId);
    };
  }
  close() {
    this.subscribers.clear();
    this.history.clear();
    this.sequence.clear();
  }
}
