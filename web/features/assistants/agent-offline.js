// What the agent pages keep while AgentPier cannot be reached. Everything stays in
// this page's memory only: a reload or a logout starts empty, like the session list.

/** No response at all, or the service briefly unreachable behind it. */
export function connectionLost(error) {
  return !error?.status || [502, 503, 504].includes(error.status);
}

/** A failed read of the opt-in switch keeps a known "on": unknown is not off. */
export function featureAfterFailure(state, error) {
  return { enabled: !!state?.enabled, error, loading: false };
}

const textSize = (history) =>
  [...(history.messages || []), ...(history.requests || [])].reduce(
    (sum, item) => sum + (typeof item?.text === "string" ? item.text.length : 0),
    0,
  );

/**
 * The last history read of recently opened agent chats, so a chat opened again while
 * offline shows what was last known. Bounded by chat count and by text size; beyond
 * the budget the oldest messages of one chat and the least recently used chats leave.
 */
export class AgentHistoryCache {
  constructor({ maxEntries = 20, maxChars = 2_000_000 } = {}) {
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
    this.entries = new Map();
    this.size = 0;
  }
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.history;
  }
  set(id, history) {
    if (!Array.isArray(history?.messages)) return;
    this.remove(id);
    let kept = history;
    let size = textSize(kept);
    while (size > this.maxChars && kept.messages.length) {
      kept = { ...kept, messages: kept.messages.slice(1) };
      size = textSize(kept);
    }
    if (size > this.maxChars) return;
    this.entries.set(id, { history: kept, size });
    this.size += size;
    for (const old of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.size <= this.maxChars) break;
      this.remove(old);
    }
  }
  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.size -= entry.size;
  }
  clear() {
    this.entries.clear();
    this.size = 0;
  }
}
