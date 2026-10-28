import { useCallback, useEffect, useRef, useState } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

// Until a push confirms a start's answer (its job's `startedAt`, or a later one), a
// push without a job or with an earlier one was read before the start.
const beforeStart = (next, startedAt) =>
  !!startedAt && (!next?.job?.startedAt || next.job.startedAt < startedAt);

/**
 * The package of a packaged server: its source, the last job (with its redacted log)
 * and the programs a build offers. It follows the live `job.mcp-package:<id>` topic:
 * every job write and source change is pushed, and `onSettled` is called once a job
 * that ran has ended. A start's own answer (setStatus) is kept until a push of its
 * job or a later one confirms it; after that every push counts, also one without a
 * job (the server restarted and lost its jobs). `server` may be null or unpackaged:
 * nothing is fetched.
 */
export default function usePackageStatus(server, onSettled) {
  const [status, replaceStatus] = useState(null);
  // The `startedAt` of a start's answer no push has confirmed yet.
  const unconfirmed = useRef(null);
  const setStatus = useCallback((next) => {
    replaceStatus((current) => {
      const value = typeof next === "function" ? next(current) : next;
      unconfirmed.current = value?.job?.startedAt ?? null;
      return value;
    });
  }, []);
  const [error, setError] = useState("");
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const id = server?.source ? server.id : null;
  const { data, error: readError } = useLiveTopic(id ? `job.mcp-package:${id}` : null);
  const wasRunning = useRef(false);
  const source = status?.source ?? server?.source ?? null;
  const job = status?.job ?? null;
  const running = source?.status === "installing" || job?.state === "running";
  const shown = job?.state === "running" ? "installing" : (source?.status ?? null);
  useEffect(() => {
    if (!data || beforeStart(data, unconfirmed.current)) return;
    unconfirmed.current = null;
    replaceStatus(data);
  }, [data]);
  useEffect(() => {
    if (wasRunning.current && !running) settled.current?.();
    wasRunning.current = running;
  }, [running]);
  return {
    status,
    setStatus,
    error: error || readError,
    setError,
    source,
    job,
    running,
    shown,
  };
}
