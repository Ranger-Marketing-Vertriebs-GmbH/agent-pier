import api from "../../lib/api.js";
import { attemptRead } from "../../lib/resource-reads.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";

const LOADING = Object.freeze({ data: null, error: "", loading: true });

/**
 * The open native requests of each session, read by one polling loop per session
 * however many views show them (chat, inbox card, agent escalation card). A loop
 * runs while the session has listeners. A read is aborted after `timeoutMs`; the
 * timeout is reported as an error and the last data stays.
 */
export function createSessionRequestsStore({
  read,
  startPolling = startVisiblePolling,
  interval = 1500,
  timeoutMs = 5000,
  env,
}) {
  const sessions = new Map();
  const publish = (entry, snapshot) => {
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener(snapshot);
  };
  const start = (sessionId, entry) => {
    entry.stop = startPolling(async (signal) => {
      const started = entry.generation;
      const result = await attemptRead((attempt) => read(sessionId, attempt), {
        signal,
        timeoutMs,
        env,
      });
      if (!result || sessions.get(sessionId) !== entry) return;
      if (started !== entry.generation) return;
      publish(
        entry,
        "data" in result
          ? { data: result.data, error: "", loading: false }
          : { data: entry.snapshot.data, error: result.error, loading: false },
      );
    }, interval);
  };
  return {
    subscribe(sessionId, listener) {
      let entry = sessions.get(sessionId);
      if (!entry) {
        entry = { listeners: new Set(), snapshot: LOADING, generation: 0, stop() {} };
        sessions.set(sessionId, entry);
        entry.listeners.add(listener);
        start(sessionId, entry);
      } else entry.listeners.add(listener);
      return () => {
        if (!entry.listeners.delete(listener) || entry.listeners.size) return;
        sessions.delete(sessionId);
        entry.stop();
      };
    },
    get(sessionId) {
      return sessions.get(sessionId)?.snapshot ?? LOADING;
    },
    refresh(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      entry.stop();
      start(sessionId, entry);
    },
    // An answer's response replaces the data at once; a read already under way
    // would bring the older state back, so it is dropped.
    update(sessionId, data) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      entry.generation += 1;
      publish(entry, { data, error: "", loading: false });
    },
  };
}

export const sessionRequests = createSessionRequestsStore({
  read: (sessionId, signal) =>
    api(`/sessions/${encodeURIComponent(sessionId)}/requests`, "GET", undefined, signal),
});
