import { useEffect, useState, useCallback, useRef } from "react";
import api from "./api.js";
import { startResourceReads } from "./resource-reads.js";
// One GET of `path`, again on refresh(); server state that changes is pushed instead
// (useLiveTopic, AGENTS.md). A read past its deadline shows a timeout error.
export default function useResource(path, { timeoutMs = 0 } = {}) {
  const [version, setVersion] = useState(0),
    [resource, setResource] = useState(null);
  const generation = useRef(0);
  const key = JSON.stringify([path, version]);
  useEffect(() => {
    if (!path) return;
    return startResourceReads({
      read: (signal) => api(path, "GET", undefined, signal),
      timeoutMs,
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
  }, [path, key, timeoutMs]);
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
