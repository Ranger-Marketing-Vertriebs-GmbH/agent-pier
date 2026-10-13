import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";
import { artifactListQuery } from "./artifact-presentation.js";

/** One page of artifacts (newest first) plus storage usage, polled every 5 s. */
export default function useArtifacts({ sessionId, projectId, page, q, pinned }) {
  const [state, setState] = useState(null),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const key = artifactListQuery({ sessionId, projectId, page, q, pinned });
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
    // The previous filter's result, so counts and rows do not flash while typing.
    stale: state?.data ?? null,
    usage: state?.usage,
    error,
    refresh: useCallback(() => setRevision((value) => value + 1), []),
  };
}
