import { useEffect, useState, useCallback, useRef } from "react";
import api from "./api.js";
import { startVisiblePolling } from "./visible-polling.js";
// `poll > 0` reads only while the tab is visible; `until(data)` ends polling for good
// once it holds for the latest data (refresh() starts a new read).
export default function useResource(path, { poll = 0, timeoutMs = 0, until } = {}) {
  const [version, setVersion] = useState(0),
    [resource, setResource] = useState(null);
  const generation = useRef(0);
  const untilRef = useRef(until);
  untilRef.current = until;
  const key = JSON.stringify([path, version]);
  useEffect(() => {
    if (!path) return;
    const controllers = new Set(),
      deadlines = new Set();
    // Resolves to whether polling should stop.
    const read = async (signal) => {
      const attempt = new AbortController();
      controllers.add(attempt);
      const abort = () => attempt.abort();
      signal?.addEventListener("abort", abort);
      const deadline = timeoutMs ? setTimeout(abort, timeoutMs) : undefined;
      deadlines.add(deadline);
      const startedGeneration = generation.current;
      try {
        const data = await api(path, "GET", undefined, attempt.signal);
        if (!attempt.signal.aborted && startedGeneration === generation.current) {
          setResource({ key, data, error: "" });
          return Boolean(untilRef.current?.(data));
        }
      } catch (error) {
        if (!attempt.signal.aborted && startedGeneration === generation.current)
          setResource((current) => ({
            key,
            data: current?.key === key ? current.data : null,
            error: error.message,
          }));
      } finally {
        // A timed-out read must not stop polling. Keep the last known data until
        // the retry arrives; late responses from the aborted attempt are ignored.
        clearTimeout(deadline);
        deadlines.delete(deadline);
        controllers.delete(attempt);
        signal?.removeEventListener("abort", abort);
      }
      return false;
    };
    let stop = () => {};
    if (poll)
      stop = startVisiblePolling(async (signal) => {
        if (await read(signal)) stop();
      }, poll);
    else read();
    return () => {
      stop();
      controllers.forEach((controller) => controller.abort());
      deadlines.forEach((deadline) => clearTimeout(deadline));
    };
  }, [path, key, poll, timeoutMs]);
  return {
    data: resource?.key === key ? resource.data : null,
    error: resource?.key === key ? resource.error : "",
    loading: Boolean(path && resource?.key !== key),
    update: useCallback(
      (data) => {
        generation.current += 1;
        setResource({ key, data, error: "" });
      },
      [key],
    ),
    refresh: useCallback(() => setVersion((value) => value + 1), []),
  };
}
