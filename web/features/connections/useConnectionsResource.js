import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";

/**
 * A read-only Zugänge summary (`/connections/usage`, `/connections/problems`): null
 * while unknown or after a failed request, so nothing shows a fake 0. It loads again
 * when `signature` changes and on `reload()`.
 */
export default function useConnectionsResource(path, signature) {
  const [data, setData] = useState(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api(path, "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setData(result && typeof result === "object" ? result : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setData(null);
      });
    return () => controller.abort();
  }, [path, signature, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { data, reload };
}
