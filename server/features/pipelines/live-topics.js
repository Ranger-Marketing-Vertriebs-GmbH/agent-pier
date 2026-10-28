// The live pipeline topics. `pipeline.run:<id>` is a run, the value
// GET /api/pipeline-runs/:id answers; a run that does not exist (any more) answers
// `{ run: null }`. `pipeline.queue:<projectId>` is a project's run queue, the value
// GET /api/pipeline-queue/:projectId answers. The engine's onChange (every saved run),
// a deleted run and the queue's onChange (items added, moved, retried, removed,
// claimed, started or failed, and its settings) signal them through
// pipelineRunChanged and pipelineQueueChanged; the topics follow nothing themselves.
// Owner only.

// Run and project ids share one form (run-store.js runId, memory identifier()).
export const PIPELINE_PARAM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const owner = (principal) => principal?.role === "owner";

/**
 * Signals the topic of `run` on `hub` (services.live, absent until it exists) and the
 * queue that shows it: a started item shows its run's status. `queue` is the run
 * queue, absent while it starts.
 */
export function pipelineRunChanged(hub, queue, run) {
  if (!hub || typeof run?.id !== "string") return;
  hub.invalidate("pipeline.run", run.id);
  // Looking up the item costs a read; only do it while a queue is watched.
  if (!hub.named("pipeline.queue").length) return;
  let projectId = run.projectId;
  try {
    projectId = queue?.find(run.id)?.projectId ?? projectId;
  } catch {
    // A closed queue store knows no item; the run's own project still applies.
  }
  if (typeof projectId === "string") hub.invalidate("pipeline.queue", projectId);
}

/** Signals the queue topic of `projectId` on `hub`. */
export function pipelineQueueChanged(hub, projectId) {
  if (typeof projectId === "string") hub?.invalidate("pipeline.queue", projectId);
}

/** The `pipeline.run` topic definition for LiveHub#define. */
export function pipelineRunTopic(services) {
  return {
    name: "pipeline.run",
    mode: "state",
    param: PIPELINE_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read(_principal, id) {
      try {
        return { run: services.pipelines.get(id) };
      } catch (error) {
        // A deleted or unknown run is a value, not a failure to read again.
        if (error?.status === 404) return { run: null };
        throw error;
      }
    },
  };
}

/** The `pipeline.queue` topic definition for LiveHub#define. */
export function pipelineQueueTopic(services) {
  return {
    name: "pipeline.queue",
    mode: "state",
    param: PIPELINE_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, projectId) => services.pipelineQueue.view(projectId),
  };
}
