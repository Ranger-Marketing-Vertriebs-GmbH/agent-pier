import { useEffect, useRef } from "react";
const hidden = () => document.visibilityState === "hidden";
// Repeats `task(signal)` every `intervalMs` after the previous run finished, so slow
// responses never overlap. It pauses while the tab is hidden and refreshes at once when
// the tab returns. `restartKey` restarts the loop; `immediate: false` waits one
// interval before the first run. The task handles its own errors.
export default function usePolling(
  task,
  intervalMs,
  { enabled = true, immediate = true, restartKey } = {},
) {
  const latest = useRef(task);
  useEffect(() => {
    latest.current = task;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer,
      running = false;
    const schedule = () => {
      clearTimeout(timer);
      if (!controller.signal.aborted && !hidden()) timer = setTimeout(tick, intervalMs);
    };
    async function tick() {
      clearTimeout(timer);
      if (controller.signal.aborted || running || hidden()) return;
      running = true;
      try {
        await latest.current(controller.signal);
      } catch {
        // The task reports its own failures; the loop keeps going.
      } finally {
        running = false;
      }
      schedule();
    }
    const visibility = () => (hidden() ? clearTimeout(timer) : tick());
    document.addEventListener("visibilitychange", visibility);
    if (immediate) tick();
    else schedule();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [intervalMs, enabled, immediate, restartKey]);
}
