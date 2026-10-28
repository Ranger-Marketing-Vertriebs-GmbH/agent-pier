import { useEffect, useRef } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

// The count of each status, pushed from the server's counts index (topic
// `pipeline.counts[:<projectId>]`) instead of one listing per status. The pills follow
// it while they are shown; a new `version` (the Refresh button) reads it once more.
// Null until the first counts of this project arrive.
export default function useRunStatusCounts({
  projectId = "",
  enabled = true,
  version = 0,
}) {
  const topic = enabled
    ? projectId
      ? `pipeline.counts:${projectId}`
      : "pipeline.counts"
    : null;
  const { data, refresh } = useLiveTopic(topic);
  const shown = useRef(version);
  useEffect(() => {
    if (shown.current === version) return;
    shown.current = version;
    refresh();
  }, [version, refresh]);
  return data?.counts ?? null;
}
