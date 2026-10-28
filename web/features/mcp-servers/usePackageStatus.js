import { useEffect, useRef, useState } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

// Once a job is held (a start's answer, a push), an answer without a job or with one
// that started before it (its `startedAt`) is older: a read from before the start.
const earlier = (next, held) =>
  !!held?.job?.startedAt &&
  (!next?.job?.startedAt || next.job.startedAt < held.job.startedAt);

/**
 * The package of a packaged server: its source, the last job (with its redacted log)
 * and the programs a build offers. It follows the live `job.mcp-package:<id>` topic:
 * every job write and source change is pushed, and `onSettled` is called once a job
 * that ran has ended. A start's own answer (setStatus) is kept until a push of its
 * job or a later one arrives. `server` may be null or unpackaged: nothing is fetched.
 */
export default function usePackageStatus(server, onSettled) {
  const [status, setStatus] = useState(null);
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
    if (data) setStatus((held) => (earlier(data, held) ? held : data));
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
