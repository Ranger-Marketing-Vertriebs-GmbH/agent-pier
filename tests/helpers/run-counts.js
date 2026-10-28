import { RUN_STATUSES } from "../../server/features/pipelines/run-counts.js";

/**
 * What GET /api/pipeline-run-counts answers for a fixture's `runs`, of all runs or
 * of the project `projectId`.
 */
export function runCountsAnswer(runs, projectId) {
  const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0]));
  for (const run of runs || [])
    if ((!projectId || run.projectId === projectId) && Object.hasOwn(counts, run.status))
      counts[run.status] += 1;
  return { counts };
}
