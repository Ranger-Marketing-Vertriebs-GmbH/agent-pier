// The state behind useLiveTopic: data pushed by the LiveClient, one REST GET where
// the push cannot carry it (`stale`, `changed`, a failed first read on the server;
// a signal topic reads the caller's route once at the start and once per `changed`),
// and the topic's previous poll, visible-only, while the channel is in fallback or
// refuses the topic. A `revoked` topic (access ended) drops what it showed at once
// and reads nothing; the LiveClient subscribes it again every 30 s while visible,
// and its data comes back once access does. A read past its deadline shows a timeout
// error; a read cut short by hiding or stopping stays silent and, if it was a
// one-time read, runs again once the tab is visible. A hidden tab requests nothing.
// Pushes and REST answers carry when the server began their read (`readAt`, the
// `X-Read-Started` header, server/lib/read-stamp.js): of the two, the later read is
// shown, so a push read before the caller's write never undoes the refresh() answer
// that shows it. Without stamps (older servers, test mocks) a push wins over a REST
// read that was under way when it arrived. Stamps compare only within one server
// instance: a restarted server (a new `hello` instance) may run on a clock that went
// back, so what is shown counts as unstamped until its next value.
import { attemptRead } from "../resource-reads.js";
import { startVisiblePolling } from "../visible-polling.js";
import { readTopicValue, topicInfo } from "./live-topics.js";
import { lastWriteStamp, readInstanceOf, readStampOf } from "../read-stamps.js";

const browser = () => ({
  document: globalThis.document,
  window: globalThis.window,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  AbortController: globalThis.AbortController,
  now: () => Date.now(),
});

const readTimeoutMs = 15000;
// How long written() waits for the push of a write before it reads the route: a write
// that leaves the value as it was sends no push.
export const WRITTEN_WAIT_MS = 2000;

/**
 * Starts following `topicId` on `client`. `read(path, signal)` is the REST GET of
 * `path` (default: the topic's route; a signal topic's data comes only from it),
 * `report({data, error, loading, connected})` gets every change. Returns
 * `{ refresh, written, set, stop }`; `refresh()` reads over REST and resolves with the
 * data, or with null when the read failed (its error is reported) or the tab is
 * hidden; `written()` follows the caller's own write: it resolves with the next value
 * shown (the write's push), reads the route after WRITTEN_WAIT_MS without one, and
 * reads it at once when no push can come.
 */
export function startLiveTopic({ topicId, path: route, client, read, report, env = {} }) {
  const scope = { ...browser(), ...env };
  const { document } = scope;
  const info = topicInfo(topicId);
  const path = route || (info?.path ? info.path(info.param) : null);
  // The route and, for a topic with sections, each section's own route, as
  // `{value, readAt, instance}`: the earliest stamp of its parts (null if one has none)
  // and the server instance that stamped them (null if unknown or not one).
  const load = async (signal) => {
    const stamps = [];
    const instances = new Set();
    const value = await readTopicValue(
      path,
      info?.sections,
      async (part) => {
        const answer = await read(part, signal);
        stamps.push(readStampOf(answer));
        instances.add(readInstanceOf(answer));
        return answer;
      },
      info?.param,
    );
    const [instance] = instances;
    const one = instances.size === 1;
    const known = one && stamps.every((stamp) => stamp !== null);
    return {
      value,
      readAt: known ? Math.min(...stamps) : null,
      instance: known ? instance : null,
    };
  };
  // `readAt`: when the server began the read behind `data`; null when unknown.
  const state = { data: null, error: "", loading: true, connected: false, readAt: null };
  let stopped = false,
    version = 0,
    lastRead = null,
    pending = false,
    again = false,
    refused = false,
    revoked = false,
    stopPolling = null,
    oneTime = null;
  // Whether a value read at `stamp` is newer than what is shown: null when either
  // stamp is unknown.
  const laterThanShown = (stamp) =>
    stamp !== null && state.readAt !== null ? stamp > state.readAt : null;
  // The server instance whose clock `state.readAt` is on: a stamp of another instance
  // (a restart, whose clock may have gone back) makes what is shown count as unstamped.
  let stampInstance = null;
  const sameServer = (instance) => {
    if (typeof instance !== "string") return;
    if (stampInstance !== null && instance !== stampInstance) state.readAt = null;
    stampInstance = instance;
  };
  // written() callers, each waiting for a value read after its write's answer (`after`,
  // `{stamp, instance}` or null): an older push that arrives later does not count.
  const waiting = new Map();
  const readAfter = (after) =>
    !after ||
    state.readAt === null ||
    (after.instance !== null &&
      stampInstance !== null &&
      after.instance !== stampInstance) ||
    state.readAt > after.stamp;
  const publish = (changes) => {
    Object.assign(state, changes);
    report({ ...state });
    if (!Object.hasOwn(changes, "data")) return;
    for (const [resolve, after] of [...waiting])
      if (state.data === null || readAfter(after)) resolve(state.data);
  };
  const accept = (result, started) => {
    if (!result || stopped) return null;
    if ("error" in result) {
      // The route refuses the value for good (a removed project's queue, access
      // withdrawn): nothing of it may show on, nor its buttons.
      if (result.status === 404 || result.status === 403) {
        version += 1;
        publish({ data: null, error: result.error, loading: false, readAt: null });
      } else publish({ error: result.error, loading: false });
      return null;
    }
    lastRead = scope.now();
    const { value, readAt, instance } = result.data;
    sameServer(instance);
    // The later read wins; without stamps, a push that arrived during the read is
    // newer than its answer.
    if (laterThanShown(readAt) ?? started === version) {
      version += 1;
      publish({ data: value, error: "", loading: false, readAt });
    }
    return value;
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
    const wanted = Boolean(path) && !revoked && (refused || client.status().fallback);
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
    if (event.type === "data" || event.type === "status") sameServer(event.instance);
    if (event.type === "data") {
      refused = revoked = false;
      const readAt = Number.isSafeInteger(event.readAt) ? event.readAt : null;
      // Read before what is shown (a refresh() answer after the caller's write).
      if (readAt === null || state.readAt === null || readAt >= state.readAt) {
        version += 1;
        publish({ data: event.data, error: "", loading: false, readAt });
      }
      polling();
    } else if (event.type === "status") {
      // A new connection subscribes refused topics again; a new refusal follows.
      if (event.connected) refused = revoked = false;
      publish({ connected: event.connected });
      polling();
    } else if (event.type === "stale" || event.type === "changed") {
      fetchAfterChange();
      unreadable();
    } else if (event.type === "revoked") {
      // Nothing read before or during the revocation may show any more.
      revoked = true;
      version += 1;
      oneTime?.abort();
      oneTime = null;
      pending = again = false;
      publish({ data: null, error: "", loading: false, readAt: null });
      polling();
    } else if (event.type === "error" && event.code) {
      refused = true;
      polling();
      unreadable();
    } else if (event.type === "error") {
      // The server's read failed: the REST route shows why (a deregistered project's
      // queue), and keeps what was shown until a push brings it back.
      fetchAfterChange();
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
    // After the caller's own write: resolves with the first value shown that was read
    // after the write's answer (its X-Read-Started), or reads the route after
    // WRITTEN_WAIT_MS; reads it at once while no push can come (no connection,
    // fallback, a refused or revoked topic).
    written: () => {
      const { connected, fallback } = client.status();
      if (stopped || !connected || fallback || refused || revoked || stopPolling)
        return fetchOnce().then((data) => data ?? null);
      // Called unbound: a browser's setTimeout refuses another `this` than window.
      const { setTimeout: later, clearTimeout: cancel } = scope;
      // The write that just answered: only a value read after it shows its change.
      const after = lastWriteStamp();
      return new Promise((resolve) => {
        let timer = null;
        const done = (data) => {
          if (!waiting.delete(done)) return;
          cancel(timer);
          resolve(data);
        };
        waiting.set(done, after);
        // No push in time (an unchanged value, a lost frame): the route answers.
        timer = later(() => {
          if (!waiting.delete(done)) return;
          fetchOnce().then((data) => resolve(data ?? null));
        }, WRITTEN_WAIT_MS);
      });
    },
    // A write's own answer replaces the data at once; a REST read already under way
    // would bring the older state back, so its answer is dropped. Later pushes win.
    set(data) {
      if (stopped) return;
      version += 1;
      publish({ data, error: "", loading: false, readAt: null });
    },
    stop() {
      stopped = true;
      for (const resolve of [...waiting.keys()]) resolve(null);
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
