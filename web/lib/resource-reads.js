import { apiCopy } from "./i18n/messages/components.js";
import { timedOut, timeoutError } from "./visible-polling.js";

const timers = (env) => ({
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  ...env,
});

/**
 * One read that ends in `{ data }`, `{ error }` (with `timedOut: true` for a
 * deadline, with the HTTP `status` of a refusal) or `null` when it was cancelled.
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
    // A refusal's HTTP status (404, 403) tells a gone value from a passing failure.
    if (!attempt.signal.aborted)
      return Number.isInteger(error?.status)
        ? { error: error.message, status: error.status }
        : { error: error.message };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
  }
  return timedOut(attempt.signal) ? { error: apiCopy.timedOut, timedOut: true } : null;
}

/**
 * The one read behind useResource (server state that changes is pushed: useLiveTopic).
 * Its result goes to `report`, unless it started before `generation()` changed (a
 * local update). Returns a stop function that cancels the read.
 */
export function startResourceReads({
  read,
  timeoutMs = 0,
  report,
  generation = () => 0,
  env = {},
}) {
  const lifetime = new AbortController();
  const started = generation();
  attemptRead(read, { signal: lifetime.signal, timeoutMs, env }).then((result) => {
    if (result && !lifetime.signal.aborted && started === generation()) report(result);
  });
  return () => lifetime.abort();
}
