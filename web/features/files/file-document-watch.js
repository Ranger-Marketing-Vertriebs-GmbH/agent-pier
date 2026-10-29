// How an open editor document learns of changes on disk. The document metadata
// route names a live topic (`file.meta:<token>`, server file-watch-topic.js); while
// the channel delivers it, the server pushes the metadata whenever the file changes
// and nothing is polled. Without a topic, after a refusal or a failed read, while the
// channel is in fallback, or for a file the server cannot watch (`watched: false`),
// the document polls the route every 15 s and on window focus, visible tabs only,
// as before. A push makes any read still under way obsolete (the store's `observed`).
import { startVisiblePolling } from "../../lib/visible-polling.js";

export const documentPollMs = 15000;

const browser = () => ({ document: globalThis.document, window: globalThis.window });

/**
 * Follows one document. `observe(signal)` reads the route, `push(value)` applies a
 * pushed value, `invalidate()` drops a read under way; `live` is the tab's live
 * client ({subscribe, status}). Returns the stop function.
 */
export function followDocument({ topic, live, observe, push, invalidate, env = {} }) {
  const { document, window } = { ...browser(), ...env };
  let stopped = false,
    refused = false,
    watched = true,
    stopPolling = null,
    focusRead = null;
  const read = () => {
    if (document.hidden) return;
    focusRead?.abort();
    focusRead = new (env.AbortController || globalThis.AbortController)();
    observe(focusRead.signal);
  };
  const polling = () => !topic || !live || refused || !watched || live.status().fallback;
  const update = () => {
    if (stopped) return;
    const wanted = polling();
    if (wanted && !stopPolling)
      stopPolling = startVisiblePolling(observe, documentPollMs, env);
    else if (!wanted && stopPolling) {
      stopPolling();
      stopPolling = null;
    }
  };
  const listener = (event) => {
    if (event.type === "data") {
      refused = false;
      watched = event.data?.watched !== false;
      push(event.data);
    } else if (event.type === "revoked" || event.type === "error") refused = true;
    else if (event.type === "stale") read();
    update();
  };
  const focus = () => {
    if (stopPolling) read();
  };
  const visibility = () => {
    if (document.hidden) invalidate();
  };
  const unsubscribe = topic && live ? live.subscribe(topic, listener) : null;
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visibility);
  update();
  return () => {
    stopped = true;
    unsubscribe?.();
    stopPolling?.();
    focusRead?.abort();
    invalidate();
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", visibility);
  };
}
