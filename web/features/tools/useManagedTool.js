import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessagesReady } from "../../lib/server-messages.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

/** Whether `current` (a pushed state) is later than the answer `next`. */
export const pushedLater = (current, next) =>
  Number.isInteger(current?.jobCount) &&
  Number.isInteger(next?.jobCount) &&
  (current.jobCount > next.jobCount ||
    (current.jobCount === next.jobCount &&
      next.status === "running" &&
      current.status !== "running"));

/**
 * A managed tool with its own dialog (REA at `/rea`, Craft Anything at
 * `/craft-anything`): its state, which follows the live `job.<tool>:current` topic
 * (each step of a running job is pushed), and the actions that change it. `apply` and
 * `update` keep their failure in `error`; `uninstall` throws so a confirmation dialog
 * can show why it was refused. `pending` is true from an `apply` or `update` until its
 * answer shows: the state says "running" only from then on, so a dialog keeps its
 * controls off through both. `refresh()` reads the route and resolves with the state,
 * or null when that read failed.
 */
export default function useManagedTool({ request, tool }) {
  const path = `/${tool}`;
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const alive = useRef(true);
  const resource = useLiveTopic(`job.${tool}:current`);
  const { data, error: readError, loading, refresh: reread } = resource;
  // Loads the English server catalog first, so reasons and progress show localized.
  const settle = useCallback(async (next) => {
    await serverMessagesReady();
    if (alive.current) setState(next);
    return next;
  }, []);
  // An action's answer, unless a push already showed a later state: a later job
  // (`jobCount`), or the end of the job this answer reports running (a job that
  // failed fast is pushed before the start's answer arrives).
  const settleAnswer = useCallback(async (next) => {
    await serverMessagesReady();
    if (alive.current)
      setState((current) => (pushedLater(current, next) ? current : next));
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
  const act = useCallback(async (target, method, body) => {
    setError("");
    setPending(true);
    try {
      const next = await requestRef.current(target, method, body);
      await serverMessagesReady();
      // With the end of `pending` in one render: the controls never come back
      // between the answer and its "running".
      if (alive.current) {
        setState((current) => (pushedLater(current, next) ? current : next));
        setPending(false);
      }
      return true;
    } catch (err) {
      if (alive.current) {
        setError(err.message);
        setPending(false);
      }
      return false;
    }
  }, []);
  const apply = useCallback((desired) => act(path, "POST", desired), [act, path]);
  const update = useCallback(() => act(`${path}/update`, "POST"), [act, path]);
  const uninstall = useCallback(async () => {
    await settleAnswer(await requestRef.current(path, "DELETE"));
  }, [settleAnswer, path]);
  return {
    state,
    loading: loading && !state,
    error,
    pending,
    apply,
    update,
    uninstall,
    refresh,
  };
}
