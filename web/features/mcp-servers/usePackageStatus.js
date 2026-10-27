import { useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";
import { apiCopy } from "../../lib/i18n/messages/components.js";
import { startVisiblePolling, timedOut } from "../../lib/visible-polling.js";

const pollMs = 2000;

/**
 * The package of a packaged server: its source, the last job (with its redacted log)
 * and the programs a build offers. Polls every 2 s while a job runs and calls
 * `onSettled` once it ends. `server` may be null or unpackaged: nothing is fetched.
 */
export default function usePackageStatus(server, onSettled) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const id = server?.source ? server.id : null;
  const source = status?.source ?? server?.source ?? null;
  const job = status?.job ?? null;
  const running = source?.status === "installing" || job?.state === "running";
  const shown = job?.state === "running" ? "installing" : (source?.status ?? null);
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    assistantApi
      .mcpPackageStatus(id)
      .then((next) => live && setStatus(next))
      .catch((failure) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [id, server?.revision, server?.source?.status]);
  useEffect(() => {
    if (!id || !running) return undefined;
    // Only a visible tab reads; a stalled read is cut off and reported.
    // The first run is skipped: the effect above just read the status.
    let first = true;
    return startVisiblePolling(async (signal) => {
      if (first) {
        first = false;
        return;
      }
      try {
        const next = await assistantApi.mcpPackageStatus(id, signal);
        setStatus(next);
        if (next.source?.status !== "installing" && next.job?.state !== "running")
          settled.current?.();
      } catch {
        if (timedOut(signal)) setError(apiCopy.timedOut);
      }
    }, pollMs);
  }, [running, id]);
  return { status, setStatus, error, setError, source, job, running, shown };
}
