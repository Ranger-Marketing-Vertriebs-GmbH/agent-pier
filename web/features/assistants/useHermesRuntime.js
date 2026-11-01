import { useCallback, useEffect, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { hermesBusy, validHermes } from "./hermes-runtime.js";

const pollMs = 2000;

/**
 * The Hermes Agent runtime state, read once and every 2 s while it installs or
 * updates. `missing` is true when the server has no Hermes endpoint (an older one
 * answers 404 or with something else).
 */
export default function useHermesRuntime() {
  const [state, setState] = useState(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (signal) => {
    try {
      const next = validHermes(await assistantApi.hermes(signal));
      // A reply that is no Hermes state comes from a server without Hermes, too.
      if (!next) {
        setMissing(true);
        return null;
      }
      setState(next);
      setMissing(false);
      setError("");
      return next;
    } catch (e) {
      if (e?.name === "AbortError") return null;
      if (e?.status === 404) setMissing(true);
      else setError(e?.message || "");
      return null;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const busy = hermesBusy(state);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => load(), pollMs);
    return () => clearInterval(timer);
  }, [busy, load]);
  return { state, setState: (next) => setState(validHermes(next)), missing, error, load };
}
