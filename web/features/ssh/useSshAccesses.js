import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";

/** One SSH list (accesses, keys or projects); a reload keeps the old list on screen. */
export default function useSshAccesses(path = "/ssh-accesses") {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const loaded = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    if (loaded.current !== path) {
      loaded.current = path;
      setData(null);
    }
    setError("");
    api(path, "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, setData, error, reload: () => setRevision((value) => value + 1) };
}
