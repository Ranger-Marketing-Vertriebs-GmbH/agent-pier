import { apiCopy } from "./i18n/messages/components.js";
import { startVisiblePolling, timedOut, timeoutError } from "./visible-polling.js";

const timers = (env) => ({
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  ...env,
});

/**
 * One read that ends in `{ data }`, `{ error }` (with `timedOut: true` for a
 * deadline) or `null` when it was cancelled.
 * A read past `timeoutMs`, or aborted by the caller's deadline, is an error with
 * a translated text: a slow server is shown, never left loading for good.
 */
export async function attemptRead(read, { signal, timeoutMs = 0, env = {} } = {}) {
  const { setTimeout, clearTimeout } = timers(env);
  const attempt = new AbortController();
  const abort = () => attempt.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort);
  const deadline = timeoutMs
    ? setTimeout(() => attempt.abort(timeoutError()), timeoutMs)
    : undefined;
  try {
    const data = await read(attempt.signal);
    if (!attempt.signal.aborted) return { data };
  } catch (error) {
    if (!attempt.signal.aborted) return { error: error.message };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
  }
  return timedOut(attempt.signal) ? { error: apiCopy.timedOut, timedOut: true } : null;
}

/**
 * The read loop behind useResource. `poll = 0` reads once; `poll > 0` reads while
 * the tab is visible until `until(data)` holds for the latest data. Each accepted
 * result goes to `report`; one that started before `generation()` changed (a local
 * update) is dropped. Returns a stop function that cancels in-flight reads.
 */
export function startResourceReads({
  read,
  poll = 0,
  timeoutMs = 0,
  until,
  report,
  generation = () => 0,
  env = {},
}) {
  const lifetime = new AbortController();
  const once = async (signal) => {
    const started = generation();
    const result = await attemptRead(read, { signal, timeoutMs, env });
    if (!result || lifetime.signal.aborted || started !== generation()) return false;
    report(result);
    return "data" in result && Boolean(until?.(result.data));
  };
  let stopPolling = () => {};
  if (poll)
    stopPolling = startVisiblePolling(
      async (signal) => {
        if (await once(signal)) stopPolling();
      },
      poll,
      env,
    );
  else once(lifetime.signal);
  return () => {
    lifetime.abort();
    stopPolling();
  };
}
