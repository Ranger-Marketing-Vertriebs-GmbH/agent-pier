// A failed refresh() of the workspace state while the live channel is healthy: the
// hub sends nothing while the state stays the same, so on an idle workspace no push
// would ever clear the error. One retry is scheduled instead, after 3 s, then 6 s,
// doubling up to 30 s, until a refresh succeeds or a push arrives.
export const firstRetryMs = 3000;
export const maxRetryMs = 30000;

/**
 * `attempt()` reads again (resolves on success, rejects on failure); `healthy()`
 * says whether the channel is still connected. `failed()` schedules the next retry
 * (never more than one timer); `stop()` cancels it and starts the backoff over: on a
 * push, a newer refresh and unmount. `scheduled()` is the wait of the pending retry,
 * or null.
 */
export function createRefreshRetry({
  attempt,
  healthy = () => true,
  timers = { setTimeout, clearTimeout },
}) {
  let timer = null;
  let wait = null;
  let delay = firstRetryMs;
  // Raised by stop(), so a retry already running does not schedule another.
  let generation = 0;
  const failed = () => {
    if (timer !== null || !healthy()) return;
    wait = delay;
    delay = Math.min(delay * 2, maxRetryMs);
    const run = generation;
    timer = timers.setTimeout(async () => {
      timer = wait = null;
      if (run !== generation) return;
      if (!healthy()) return stop();
      try {
        await attempt();
      } catch {
        if (run === generation) failed();
        return;
      }
      if (run === generation) stop();
    }, wait);
  };
  const stop = () => {
    generation += 1;
    if (timer !== null) timers.clearTimeout(timer);
    timer = wait = null;
    delay = firstRetryMs;
  };
  return { failed, stop, scheduled: () => wait };
}
