import { useEffect, useState, useCallback, useRef } from "react";
import api from "./api.js";
export default function useResource(path, { poll = 0, timeoutMs = 0 } = {}) {
  const [version, setVersion] = useState(0),
    [resource, setResource] = useState(null);
  const generation = useRef(0);
  const key = JSON.stringify([path, version]);
  useEffect(() => {
    if (!path) return;
    let disposed = false,
      controller,
      timer,
      deadline;
    const read = async () => {
      const attempt = new AbortController();
      controller = attempt;
      if (timeoutMs) deadline = setTimeout(() => attempt.abort(), timeoutMs);
      const startedGeneration = generation.current;
      try {
        const data = await api(path, "GET", undefined, attempt.signal);
        if (!attempt.signal.aborted && startedGeneration === generation.current)
          setResource({ key, data, error: "" });
      } catch (error) {
        if (!attempt.signal.aborted && startedGeneration === generation.current)
          setResource((current) => ({
            key,
            data: current?.key === key ? current.data : null,
            error: error.message,
          }));
      } finally {
        clearTimeout(deadline);
        // A timed-out read must not stop polling. Keep the last known data until
        // the retry arrives; late responses from the aborted attempt are ignored.
        if (poll && !disposed) timer = setTimeout(read, poll);
      }
    };
    read();
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
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
