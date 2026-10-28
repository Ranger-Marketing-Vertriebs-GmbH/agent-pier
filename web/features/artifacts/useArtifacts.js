import { useCallback, useRef } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { artifactListQuery } from "./artifact-presentation.js";

/**
 * One page of artifacts (newest first) plus storage usage. The usage is pushed
 * (`artifacts.usage`); the page is read once and again on each `changed` of
 * `artifacts.changed` (without the live channel, both every 5 s).
 */
export default function useArtifacts({ sessionId, projectId, page, q, pinned }) {
  const key = artifactListQuery({ sessionId, projectId, page, q, pinned });
  const list = useLiveTopic("artifacts.changed", `/artifacts?${key}`);
  const usage = useLiveTopic("artifacts.usage");
  // The previous filter's result, so counts and rows do not flash while typing.
  const last = useRef(null);
  if (list.data) last.current = list.data;
  const { refresh: refreshList } = list;
  const { refresh: refreshUsage } = usage;
  return {
    data: list.data,
    stale: last.current,
    usage: usage.data ?? undefined,
    error: list.error || usage.error,
    refresh: useCallback(() => {
      refreshList();
      refreshUsage();
    }, [refreshList, refreshUsage]),
  };
}
