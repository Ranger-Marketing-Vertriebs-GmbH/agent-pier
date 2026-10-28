// The state behind useLiveTopic: data pushed by the LiveClient, one REST GET where
// the push cannot carry it (`stale`, `changed`, a failed first read on the server;
// a signal topic reads the caller's route once at the start and once per `changed`),
// and the topic's previous poll, visible-only, while the channel is in fallback or
// refuses the topic. A read past its deadline shows a timeout error; a read cut
// short by hiding or stopping stays silent and, if it was a one-time read, runs again
// once the tab is visible. A hidden tab requests nothing.
import { attemptRead } from "../resource-reads.js";
import { startVisiblePolling } from "../visible-polling.js";
import { readTopicValue, topicInfo } from "./live-topics.js";

const browser = () => ({
  document: globalThis.document,
  window: globalThis.window,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  AbortController: globalThis.AbortController,
  now: () => Date.now(),
});

const readTimeoutMs = 15000;

/**
 * Starts following `topicId` on `client`. `read(path, signal)` is the REST GET of
 * `path` (default: the topic's route; a signal topic's data comes only from it),
 * `report({data, error, loading, connected})` gets every change. Returns
 * `{ refresh, set, stop }`; `refresh()` reads over REST and resolves with the data, or
 * with null when the read failed (its error is reported) or the tab is hidden.
 */
export function startLiveTopic({ topicId, path: route, client, read, report, env = {} }) {
  const scope = { ...browser(), ...env };
  const { document } = scope;
  const info = topicInfo(topicId);
  const path = route || (info?.path ? info.path(info.param) : null);
  // The route and, for a topic with sections, each section's own route.
  const load = (signal) =>
    readTopicValue(path, info?.sections, (part) => read(part, signal), info?.param);
  const state = { data: null, error: "", loading: true, connected: false };
  let stopped = false,
    version = 0,
    lastRead = null,
    pending = false,
    again = false,
    refused = false,
    stopPolling = null,
    oneTime = null;
  const publish = (changes) => {
    Object.assign(state, changes);
    report({ ...state });
  };
  const accept = (result, started) => {
    if (!result || stopped) return null;
    if ("error" in result) {
      publish({ error: result.error, loading: false });
      return null;
    }
    lastRead = scope.now();
    // A push that arrived during the read is newer than its answer.
    if (started === version) {
      version += 1;
      publish({ data: result.data, error: "", loading: false });
    }
    return result.data;
  };
  const fetchOnce = async () => {
    if (!path || stopped) return null;
    if (document.hidden) {
      pending = true;
      return null;
    }
    pending = false;
    oneTime?.abort();
    const controller = new scope.AbortController();
    oneTime = controller;
    const started = version;
    const result = await attemptRead(load, {
      signal: controller.signal,
      timeoutMs: readTimeoutMs,
      env: scope,
    });
    if (oneTime === controller) oneTime = null;
    const data = accept(result, started);
    if (again && !oneTime && !stopped) {
      again = false;
      fetchOnce();
    }
    return data;
  };
  // A change during a read reads once more after it, instead of cutting it short:
  // changes faster than the read would otherwise never let one finish.
  const fetchAfterChange = () => {
    if (oneTime) again = true;
    else fetchOnce();
  };
  const polling = () => {
    const wanted = Boolean(path) && (refused || client.status().fallback);
    if (wanted && !stopPolling) {
      // A read that just finished counts as the poll's first run.
      const skipFirst = lastRead !== null && scope.now() - lastRead < info.interval;
      stopPolling = startVisiblePolling(
        async (signal) => {
          const started = version;
          accept(await attemptRead(load, { signal, env: scope }), started);
        },
        info.interval,
        scope,
        { skipFirst },
      );
    } else if (!wanted && stopPolling) {
      stopPolling();
      stopPolling = null;
    }
  };
  const visibility = () => {
    if (document.hidden) {
      if (oneTime) {
        oneTime.abort();
        oneTime = null;
        pending = true;
        again = false;
      }
    } else if (pending) fetchOnce();
  };
  // Without a REST route nothing more can come: stop showing the topic as loading.
  const unreadable = () => {
    if (!path && state.loading) publish({ loading: false });
  };
  const listener = (event) => {
    if (event.type === "data") {
      version += 1;
      refused = false;
      publish({ data: event.data, error: "", loading: false });
      polling();
    } else if (event.type === "status") {
      // A new connection subscribes refused topics again; a new refusal follows.
      if (event.connected) refused = false;
      publish({ connected: event.connected });
      polling();
    } else if (event.type === "stale" || event.type === "changed") {
      fetchAfterChange();
      unreadable();
    } else if (event.type === "revoked" || (event.type === "error" && event.code)) {
      refused = true;
      polling();
      unreadable();
    } else if (event.type === "error" && state.data === null) {
      fetchOnce();
      unreadable();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  const unsubscribe = client.subscribe(topicId, listener, {
    sampled: Boolean(info?.sampled),
  });
  publish({ connected: client.status().connected });
  polling();
  // A signal brings no data of its own: its route is read once to begin with, unless
  // the fallback poll already reads it.
  if (info?.mode === "signal" && !stopPolling) fetchOnce();
  return {
    // Resolves with what the REST route answered, even when a push that arrived
    // during the read is newer (then the state keeps the push, and the caller gets
    // the older answer it asked for). Resolves null when the read failed (its error
    // is in the state), the tab is hidden (the read runs once it is visible) or the
    // topic has no REST route; it never rejects, so no caller waits on a failure.
    refresh: () => fetchOnce().then((data) => data ?? null),
    // A write's own answer replaces the data at once; a REST read already under way
    // would bring the older state back, so its answer is dropped. Later pushes win.
    set(data) {
      if (stopped) return;
      version += 1;
      publish({ data, error: "", loading: false });
    },
    stop() {
      stopped = true;
      unsubscribe();
      stopPolling?.();
      oneTime?.abort();
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}

/** Calls `onChange` for each `changed` frame of `topicId`; returns the stop function. */
export function followSignal(client, topicId, onChange) {
  return client.subscribe(topicId, (event) => {
    if (event.type === "changed") onChange();
  });
}
