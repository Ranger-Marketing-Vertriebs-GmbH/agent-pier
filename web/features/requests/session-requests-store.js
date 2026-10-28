import api from "../../lib/api.js";
import { liveClient } from "../../lib/live/live-client.js";
import { startLiveTopic } from "../../lib/live/live-topic-reader.js";

const LOADING = Object.freeze({ data: null, error: "", loading: true });

// Chat waits only for open requests or while no answer has arrived yet. An error
// over held data never blocks: the chat never blocks on a slow server.
export function requestsBlockChat({ data, error, loading }) {
  return Boolean(loading || (error && !data) || data?.requests?.length);
}

/**
 * Follows the live `session.requests:<id>` topic (REST while the channel falls back).
 * `report({data, error, loading})` gets every change; returns `{ refresh, set, stop }`.
 */
export function followSessionRequests(sessionId, report) {
  return startLiveTopic({
    topicId: `session.requests:${sessionId}`,
    client: liveClient(),
    read: (path, signal) => api(path, "GET", undefined, signal),
    report,
  });
}

// Each request carries when this tab received it: a pushed list is sent only when it
// changes, so `interaction.age` is as old as the frame (request-interaction.js).
const stamped = (data, receivedAt) =>
  Array.isArray(data?.requests)
    ? { ...data, requests: data.requests.map((entry) => ({ ...entry, receivedAt })) }
    : data;

/**
 * The open native requests of each session, followed once per session however many
 * views show them (chat, inbox card, agent escalation card, terminal handoff). The
 * topic is followed while the session has listeners.
 */
export function createSessionRequestsStore({
  follow = followSessionRequests,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  const publish = (entry, snapshot) => {
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener(snapshot);
  };
  const receive = (entry, { data, error, loading }) => {
    if (sessions.get(entry.sessionId) !== entry) return;
    const current = entry.snapshot;
    const fresh = data !== entry.raw;
    if (!fresh && error === current.error && loading === current.loading) return;
    entry.raw = data;
    publish(entry, {
      data: fresh ? stamped(data, now()) : current.data,
      error,
      loading,
    });
  };
  return {
    subscribe(sessionId, listener) {
      let entry = sessions.get(sessionId);
      if (!entry) {
        entry = { sessionId, listeners: new Set(), snapshot: LOADING, raw: null };
        sessions.set(sessionId, entry);
        entry.listeners.add(listener);
        const created = entry;
        entry.reader = follow(sessionId, (state) => receive(created, state));
      } else entry.listeners.add(listener);
      return () => {
        if (!entry.listeners.delete(listener) || entry.listeners.size) return;
        sessions.delete(sessionId);
        entry.reader.stop();
      };
    },
    get(sessionId) {
      return sessions.get(sessionId)?.snapshot ?? LOADING;
    },
    /** Reads the session's requests over REST again. */
    refresh(sessionId) {
      sessions.get(sessionId)?.reader.refresh();
    },
    // An answer's response replaces the data at once; a REST read already under way
    // would bring the older state back, so it is dropped.
    update(sessionId, data) {
      sessions.get(sessionId)?.reader.set(data);
    },
  };
}

export const sessionRequests = createSessionRequestsStore();
