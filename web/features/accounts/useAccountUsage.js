import { useEffect, useState } from "react";
import api from "../../lib/api.js";

/** "Used by" for every entry; null while unknown or when the request failed. */
export default function useAccountUsage(signature) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/accounts/usage", "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setUsage(result && typeof result === "object" ? result : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsage(null);
      });
    return () => controller.abort();
  }, [signature]);
  return usage;
}
