import { useCallback, useEffect, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { runtimeInfoOf, validRuntimes } from "./runtime-list.js";

/**
 * The runtimes a new agent may run on, read once: `runtimes` is [] until the answer
 * and after a failure, and `infoOf(id)` the view of one (runtime-list.js
 * runtimeInfoOf). What a runtime states about itself does not change while the
 * server runs, so nothing is read again.
 */
export default function useRuntimes() {
  const [runtimes, setRuntimes] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    assistantApi
      .runtimes(controller.signal)
      .then((data) => setRuntimes(validRuntimes(data)))
      .catch(() => {
        /* Without the list every runtime's traits stay unknown. */
      });
    return () => controller.abort();
  }, []);
  const infoOf = useCallback((id) => runtimeInfoOf(runtimes, id), [runtimes]);
  return { runtimes, infoOf };
}
