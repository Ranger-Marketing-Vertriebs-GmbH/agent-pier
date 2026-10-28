// The slim list view of a run (GET /api/pipeline-runs?view=list, the `pipeline.runs`
// topic): only what the run tables and project hints show. A run document carries
// every stage's profile snapshot, verdicts and the whole execution log; the list needs
// none of them, so the view never has `executionLog`, verdicts, prompts or `actions`.

// The task's first line is the table's headline (web/features/pipelines/run-title.js
// cuts it to 160 characters); a longer cut keeps that ellipsis decision intact.
const TASK_LINE_MAX = 400;

const taskLine = (task) =>
  typeof task === "string"
    ? task.trim().split(/\r?\n/, 1)[0].slice(0, TASK_LINE_MAX)
    : "";

// Only defined fields, so the view matches its JSON round trip exactly.
const defined = (entry) =>
  Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));

function nodeView(node) {
  const name = node?.profileSnapshot?.name;
  return defined({
    id: node?.id,
    group: node?.group,
    status: node?.status,
    startedAt: node?.startedAt,
    finishedAt: node?.finishedAt,
    profileSnapshot: typeof name === "string" ? { name } : undefined,
  });
}

/** The list view of `run`: id, status, task line, pipeline, folder, project, times. */
export function runListView(run) {
  return defined({
    id: run.id,
    status: run.status,
    task: taskLine(run.task),
    pipelineName: run.pipelineName,
    cwd: run.cwd,
    projectId: run.projectId ?? null,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    currentNodeId: run.currentNodeId,
    // Whether verification runs now; the table shows it instead of the status.
    verifyJob: Boolean(run.verifyJob),
    nodes: Array.isArray(run.nodes) ? run.nodes.map(nodeView) : [],
  });
}
