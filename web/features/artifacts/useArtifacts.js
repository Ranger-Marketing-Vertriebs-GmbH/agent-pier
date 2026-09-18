import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";
export default function useArtifacts({ sessionId, projectId, page }) {
  const [state, setState] = useState(null),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const query = new URLSearchParams({ page: String(page) });
  if (sessionId) query.set("sessionId", sessionId);
  if (projectId) query.set("projectId", projectId);
  const key = query.toString();
  useEffect(
    () =>
      startVisiblePolling(async (signal) => {
        try {
          const [data, usage] = await Promise.all([
            api(`/artifacts?${key}`, "GET", undefined, signal),
            api("/artifacts/usage", "GET", undefined, signal),
          ]);
          if (!signal.aborted) {
            setState({ key, data, usage });
            setError("");
          }
        } catch (failure) {
          if (!signal.aborted) setError(failure.message);
        }
      }, 5000),
    [key, revision],
  );
  return {
    data: state?.key === key ? state.data : null,
    usage: state?.usage,
    error,
    refresh: useCallback(() => setRevision((value) => value + 1), []),
  };
}
