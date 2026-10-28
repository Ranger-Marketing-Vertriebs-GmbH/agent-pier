import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessagesReady } from "../../lib/server-messages.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

/**
 * The managed REA tool (`/api/rea`): its state, which follows the live
 * `job.rea:current` topic (each step of a running job is pushed), and the actions
 * that change it. `apply` and `update` keep their failure in `error`; `uninstall`
 * throws so a confirmation dialog can show why it was refused. `refresh()` reads the
 * route and resolves with the state, or null when that read failed.
 */
export default function useRea({ request }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const requestRef = useRef(request);
  requestRef.current = request;
  const alive = useRef(true);
  const resource = useLiveTopic("job.rea:current");
  const { data, error: readError, loading, refresh: reread } = resource;
  // Loads the English server catalog first, so reasons and progress show localized.
  const settle = useCallback(async (next) => {
    await serverMessagesReady();
    if (alive.current) setState(next);
    return next;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!data) return;
    void settle(data);
    setError("");
  }, [data, settle]);
  useEffect(() => {
    if (readError) setError(readError);
  }, [readError]);
  const refresh = useCallback(async () => {
    const next = await reread();
    return next ? settle(next) : null;
  }, [reread, settle]);
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
  return { state, loading: loading && !state, error, apply, update, uninstall, refresh };
}
