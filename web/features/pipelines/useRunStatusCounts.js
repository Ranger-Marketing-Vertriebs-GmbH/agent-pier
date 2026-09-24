import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { runStatuses } from "./run-presentation.js";

// The run list carries only its own total, so each status pill costs one listing
// request. The counts poll no faster than the list and only while they are shown.
export default function useRunStatusCounts({
  projectId = "",
  enabled = true,
  version = 0,
}) {
  const [state, setState] = useState({ key: "", counts: null });
  const key = JSON.stringify([projectId, version]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer;
    const read = async () => {
      try {
        const totals = await Promise.all(
          runStatuses.map((status) =>
            api(
              `/pipeline-runs?${new URLSearchParams({
                status,
                ...(projectId ? { projectId } : {}),
              })}`,
              "GET",
              undefined,
              controller.signal,
            ).then((data) => [status, data.total || 0]),
          ),
        );
        if (!controller.signal.aborted)
          setState({ key, counts: Object.fromEntries(totals) });
      } catch {
        // The run list reports request failures; the pills keep their last counts.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 5000);
      }
    };
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, projectId]);
  return state.key === key ? state.counts : null;
}
