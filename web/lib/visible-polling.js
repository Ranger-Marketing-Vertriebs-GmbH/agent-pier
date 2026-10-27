const browser = () => ({
  document: globalThis.document,
  window: globalThis.window,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  AbortController: globalThis.AbortController,
});
// Foregrounding must not wait for a request suspended by the operating system.
// A hidden tab runs nothing: hiding aborts the running request and drops the timer.
export function startVisiblePolling(run, interval, env = {}) {
  const { document, window, setTimeout, clearTimeout, AbortController } = {
    ...browser(),
    ...env,
  };
  let disposed = false,
    timer,
    timeout,
    controller;
  const cancel = () => {
    clearTimeout(timer);
    clearTimeout(timeout);
    controller?.abort();
  };
  const poll = async () => {
    cancel();
    if (disposed || document.hidden) return;
    const current = new AbortController();
    controller = current;
    const deadline = setTimeout(() => current.abort(), 15000);
    timeout = deadline;
    try {
      await run(current.signal);
    } catch {
      // The consumer owns visible errors; cancellation needs no user action.
    } finally {
      clearTimeout(deadline);
      if (!disposed && controller === current && !document.hidden)
        timer = setTimeout(poll, interval);
    }
  };
  const visibility = () => (document.hidden ? cancel() : poll());
  const resume = () => {
    if (!document.hidden) poll();
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", resume);
  poll();
  return () => {
    disposed = true;
    cancel();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("online", resume);
  };
}
