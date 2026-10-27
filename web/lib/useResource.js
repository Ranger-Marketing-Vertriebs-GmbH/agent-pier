import { useEffect, useState, useCallback, useRef } from "react";
import api from "./api.js";
import { startResourceReads } from "./resource-reads.js";
// `poll > 0` reads only while the tab is visible; `until(data)` ends polling for good
// once it holds for the latest data (refresh() starts a new read). A read past its
// deadline shows a timeout error, keeps the last data and polling goes on.
export default function useResource(path, { poll = 0, timeoutMs = 0, until } = {}) {
  const [version, setVersion] = useState(0),
    [resource, setResource] = useState(null);
  const generation = useRef(0);
  const untilRef = useRef(until);
  untilRef.current = until;
  const key = JSON.stringify([path, version]);
  useEffect(() => {
    if (!path) return;
    return startResourceReads({
      read: (signal) => api(path, "GET", undefined, signal),
      poll,
      timeoutMs,
      until: (data) => untilRef.current?.(data),
      generation: () => generation.current,
      report: (result) =>
        setResource((current) =>
          "data" in result
            ? { key, data: result.data, error: "" }
            : {
                key,
                data: current?.key === key ? current.data : null,
                error: result.error,
              },
        ),
    });
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
