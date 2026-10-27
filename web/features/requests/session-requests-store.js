import api from "../../lib/api.js";
import { attemptRead } from "../../lib/resource-reads.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";

const LOADING = Object.freeze({ data: null, error: "", loading: true });
// Timeouts in a row over held data before the error shows: one slow read must
// not make the chat flap.
const QUIET_TIMEOUTS = 2;

// Chat waits only for open requests or while no answer has arrived yet. An error
// over held data never blocks: the chat never blocks on a slow server.
export function requestsBlockChat({ data, error, loading }) {
  return Boolean(loading || (error && !data) || data?.requests?.length);
}

/**
 * The open native requests of each session, read by one polling loop per session
 * however many views show them (chat, inbox card, agent escalation card). A loop
 * runs while the session has listeners. A read is aborted after `timeoutMs`; the
 * timeout shows at once without data, after three in a row over held data, which stays.
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
      entry.timeouts = result.timedOut ? entry.timeouts + 1 : 0;
      if (entry.snapshot.data && entry.timeouts && entry.timeouts <= QUIET_TIMEOUTS)
        return;
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
        entry = {
          listeners: new Set(),
          snapshot: LOADING,
          generation: 0,
          timeouts: 0,
          stop() {},
        };
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
