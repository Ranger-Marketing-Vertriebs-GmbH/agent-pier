import useLiveTopic from "../../lib/live/useLiveTopic.js";

/**
 * One page of the run list (GET /api/pipeline-runs?view=list: each run in its slim
 * list view), in the shape of useLiveTopic.
 * Page 1 is pushed whole (topic `pipeline.runs:<projectId|*>:<status|*>`); a later
 * page is read over REST and read again once on each `changed` of
 * `pipeline.runs.changed[:<projectId>]`. Nothing is read while `enabled` is false.
 */
export default function useRunList({ projectId = "", status = "", page = 1, enabled }) {
  const first = page === 1;
  const topic = !enabled
    ? null
    : first
      ? `pipeline.runs:${projectId || "*"}:${status || "*"}`
      : projectId
        ? `pipeline.runs.changed:${projectId}`
        : "pipeline.runs.changed";
  const path =
    enabled && !first
      ? `/pipeline-runs?${new URLSearchParams({
          view: "list",
          page: String(page),
          ...(projectId ? { projectId } : {}),
          ...(status ? { status } : {}),
        })}`
      : undefined;
  return useLiveTopic(topic, path);
}
