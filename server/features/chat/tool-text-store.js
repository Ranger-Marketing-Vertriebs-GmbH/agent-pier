export class ToolTextStore {
  constructor({ maxBytes = 32 * 1048576, maxEntryBytes = 4 * 1048576 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.entries = new Map();
    this.size = 0;
  }

  get bytes() {
    return this.size;
  }

  key(sessionId, messageId) {
    return JSON.stringify([sessionId, messageId]);
  }

  drop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.size -= entry.text.length * 2;
    this.entries.delete(key);
  }

  remember(sessionId, messageId, providerSessionId, text) {
    const key = this.key(sessionId, messageId);
    this.drop(key);
    if (text.length * 2 > this.maxEntryBytes) return;
    this.entries.set(key, { sessionId, text, providerSessionId });
    this.size += text.length * 2;
    while (this.size > this.maxBytes) this.drop(this.entries.keys().next().value);
  }

  lookup(sessionId, messageId) {
    const key = this.key(sessionId, messageId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { text: entry.text, providerSessionId: entry.providerSessionId };
  }

  forgetSession(sessionId) {
    for (const [key, entry] of this.entries)
      if (entry.sessionId === sessionId) this.drop(key);
  }
}
