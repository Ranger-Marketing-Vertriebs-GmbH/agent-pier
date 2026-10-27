import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessagesReady } from "../../lib/server-messages.js";
import { reaCopy as copy } from "../../lib/i18n/messages/rea.js";

const pollMs = 1000;

/**
 * The managed REA tool (`/api/rea`): its state, polled while a job runs, and the
 * actions that change it. `apply` and `update` keep their failure in `error`;
 * `uninstall` throws so a confirmation dialog can show why it was refused.
 */
export default function useRea({ request }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef(request);
  requestRef.current = request;
  const alive = useRef(true);
  // Loads the English server catalog first, so reasons and progress show localized.
  const settle = useCallback(async (next) => {
    await serverMessagesReady();
    if (alive.current) setState(next);
    return next;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await requestRef.current("/rea");
      await settle(next);
      if (alive.current) setError("");
      return next;
    } catch (err) {
      if (alive.current) setError(err.message || copy.loadFailed);
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [settle]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, refresh]);
  const act = useCallback(
    async (path, method, body) => {
      setError("");
      try {
        await settle(await requestRef.current(path, method, body));
        return true;
      } catch (err) {
        if (alive.current) setError(err.message);
        return false;
      }
    },
    [settle],
  );
  const apply = useCallback((desired) => act("/rea", "POST", desired), [act]);
  const update = useCallback(() => act("/rea/update", "POST"), [act]);
  const uninstall = useCallback(async () => {
    await settle(await requestRef.current("/rea", "DELETE"));
  }, [settle]);
  return { state, loading, error, apply, update, uninstall, refresh };
}
