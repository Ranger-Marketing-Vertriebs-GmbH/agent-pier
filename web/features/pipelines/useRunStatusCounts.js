import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { runStatuses } from "./run-presentation.js";

// Every listing is a full scan on the server, so the pills poll slowly.
const pillPoll = 30000;

// What the pills depend on in the polled list: its total and the id and status of
// every listed run. Missing data (loading, a failed read, the run detail) has none.
export function listSignature(data) {
  if (!data || !Number.isFinite(data.total)) return "";
  return JSON.stringify([
    data.total,
    (data.runs || []).map((run) => `${run.id}:${run.status}`),
  ]);
}

// The run list carries only its own total, so each status pill costs one listing
// request. The pills load while they are shown, refresh slowly, after `version` changes
// and whenever the polled list page (`listKey` names its filter and page) changes its
// total or the status of a listed run.
export default function useRunStatusCounts({
  projectId = "",
  enabled = true,
  version = 0,
  listKey = "",
  listData,
}) {
  const [state, setState] = useState({ key: "", projectId: null, counts: null });
  const [changes, setChanges] = useState(0);
  const seen = useRef({ listKey: null, signature: "", data: null, cached: null });
  const signature = listSignature(listData);
  useEffect(() => {
    const last = seen.current;
    // While the pills are off (a run detail is open) the list keeps its last data and
    // shows it again on return; the next fresh read, not that copy, starts over, so
    // returning costs only the pill round of the returning page itself.
    if (!enabled) {
      seen.current = { listKey: null, signature: "", data: null, cached: last.data };
      return;
    }
    if (listData && listData === last.cached) return;
    seen.current = { listKey, signature, data: listData, cached: null };
    // Without list data (loading, paging, a failed read) the next read starts over.
    if (!signature || !last.signature || last.listKey !== listKey) return;
    if (last.signature !== signature) setChanges((value) => value + 1);
  }, [enabled, listKey, signature, listData]);
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
