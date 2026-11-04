import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";
import { diffFailure, keptDiff, runDiffKey } from "./run-diff-state.js";

const idle = { data: null, error: "", failure: null, loading: false };
const none = [];

/**
 * The whole-run diff (GET /pipeline-runs/:id/diff) while `enabled`. It is read when
 * enabled, when the run's push changes its status, current stage, attempt count or
 * waiting group members, and on `refresh()`; an answer with the shown fingerprint
 * keeps the shown diff. A failed read keeps the shown diff beside the error. `unavailable`: the worktree is gone;
 * `imported`: a history-only run without changes on this host.
 */
export default function useRunDiff(run, enabled) {
  const [refreshes, setRefreshes] = useState(0);
  const [state, setState] = useState(idle);
  const id = run?.id;
  const key = runDiffKey(run, refreshes);
  useEffect(() => {
    if (!enabled || !id) return;
    const controller = new AbortController();
    setState((last) => ({ ...last, error: "", loading: true }));
    api(
      `/pipeline-runs/${encodeURIComponent(id)}/diff`,
      "GET",
      undefined,
      controller.signal,
    ).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setState((last) => ({
          data: keptDiff(last.data, answer),
          error: "",
          failure: null,
          loading: false,
        }));
      },
      (error) => {
        if (controller.signal.aborted) return;
        const failure = diffFailure(error);
        setState((last) => ({
          data: failure === "error" ? last.data : null,
          error: failure === "error" ? error?.message || String(error) : "",
          failure,
          loading: false,
        }));
      },
    );
    return () => controller.abort();
    // `key` stands for the run's status, current stage, attempts and refresh count.
  }, [enabled, id, key]);
  const refresh = useCallback(() => setRefreshes((count) => count + 1), []);
  return {
    files: state.data?.files ?? none,
    truncated: state.data?.truncated === true,
    loaded: state.data !== null,
    loading: state.loading,
    error: state.error,
    unavailable: state.failure === "gone",
    imported: state.failure === "imported",
    refresh,
  };
}
