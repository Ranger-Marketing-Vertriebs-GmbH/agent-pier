import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { runStatuses } from "./run-presentation.js";

// Every listing is a full scan on the server, so the pills poll slowly.
const pillPoll = 30000;

// The run list carries only its own total, so each status pill costs one listing
// request. The pills load while they are shown, refresh slowly, after `version` changes
// and whenever the polled list's total changes under the same filter (`listKey`).
export default function useRunStatusCounts({
  projectId = "",
  enabled = true,
  version = 0,
  listKey = "",
  listTotal,
}) {
  const [state, setState] = useState({ key: "", projectId: null, counts: null });
  const [changes, setChanges] = useState(0);
  const seen = useRef({ listKey: null, total: undefined });
  useEffect(() => {
    if (!Number.isFinite(listTotal)) return;
    const last = seen.current;
    seen.current = { listKey, total: listTotal };
    if (
      last.listKey === listKey &&
      Number.isFinite(last.total) &&
      last.total !== listTotal
    )
      setChanges((value) => value + 1);
  }, [listKey, listTotal]);
  const key = JSON.stringify([projectId, version, changes]);
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
          setState({ key, projectId, counts: Object.fromEntries(totals) });
      } catch {
        // The run list reports request failures; the pills keep their last counts.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, pillPoll);
      }
    };
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, projectId]);
  // A refresh keeps the last counts of the same project until the new ones arrive.
  return state.projectId === projectId ? state.counts : null;
}
