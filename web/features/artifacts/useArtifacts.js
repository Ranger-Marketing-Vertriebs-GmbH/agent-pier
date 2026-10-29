import { useCallback, useRef } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { artifactListQuery } from "./artifact-presentation.js";

/**
 * One page of artifacts (newest first) plus storage usage. The usage is pushed
 * (`artifacts.usage`) unless `usage` is false (a panel that does not show it); the
 * page is read once and again on each `changed` of `artifacts.changed` (without the
 * live channel, both every 5 s). `written()` follows the caller's own pin or delete:
 * the change arrives as `changed`, so it resolves once the list was read again
 * (useLiveTopic written()).
 */
export default function useArtifacts({
  sessionId,
  projectId,
  page,
  q,
  pinned,
  usage: withUsage = true,
}) {
  const key = artifactListQuery({ sessionId, projectId, page, q, pinned });
  const list = useLiveTopic("artifacts.changed", `/artifacts?${key}`);
  const usage = useLiveTopic(withUsage ? "artifacts.usage" : null);
  // The previous filter's result, so counts and rows do not flash while typing.
  const last = useRef(null);
  if (list.data) last.current = list.data;
  const { written: writtenList } = list;
  const { written: writtenUsage } = usage;
  return {
    data: list.data,
    stale: last.current,
    usage: usage.data ?? undefined,
    error: list.error || usage.error,
    // Resolves once the list shows the write; the usage follows on its own.
    written: useCallback(() => {
      writtenUsage();
      return writtenList();
    }, [writtenList, writtenUsage]),
  };
}
