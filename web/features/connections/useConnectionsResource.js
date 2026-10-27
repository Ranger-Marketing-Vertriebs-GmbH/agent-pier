import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";

/**
 * A read-only Zugänge resource (`/connections/usage`, `/connections/problems`,
 * `/mail/accounts`): null while unknown or after a failed request, so nothing shows a
 * fake 0; `error` keeps the failed request's message. It loads again when `signature`
 * changes and on `reload()`.
 */
export default function useConnectionsResource(path, signature) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api(path, "GET", undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result && typeof result === "object" ? result : null);
        setError("");
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setData(null);
        setError(failure?.message || String(failure));
      });
    return () => controller.abort();
  }, [path, signature, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { data, error, reload };
}
