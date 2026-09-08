import { useEffect, useState, useCallback, useRef } from "react";
import api from "./api.js";
export default function useResource(path, { poll = 0 } = {}) {
  const [version, setVersion] = useState(0),
    [resource, setResource] = useState(null);
  const generation = useRef(0);
  const key = JSON.stringify([path, version]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer;
    const read = async () => {
      const startedGeneration = generation.current;
      try {
        const data = await api(path, "GET", undefined, controller.signal);
        if (!controller.signal.aborted && startedGeneration === generation.current)
          setResource({ key, data, error: "" });
      } catch (error) {
        if (!controller.signal.aborted && startedGeneration === generation.current)
          setResource((current) => ({
            key,
            data: current?.key === key ? current.data : null,
            error: error.message,
          }));
      } finally {
        if (poll && !controller.signal.aborted) timer = setTimeout(read, poll);
      }
    };
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, key, poll]);
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
