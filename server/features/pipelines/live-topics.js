// The live pipeline topics. `pipeline.run:<id>` is a run, the value
// GET /api/pipeline-runs/:id answers; a run that does not exist (any more) answers
// `{ run: null }`. `pipeline.queue:<projectId>` is a project's run queue, the value
// GET /api/pipeline-queue/:projectId answers. The engine's onChange (every saved run),
// a deleted run and the queue's onChange (items added, moved, retried, removed,
// claimed, started or failed, and its settings) signal them through
// pipelineRunChanged and pipelineQueueChanged; the topics follow nothing themselves.
// Owner only.

import { RUN_STATUSES } from "./run-counts.js";

// Run and project ids share one form (run-store.js runId, memory identifier()).
const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";
export const PIPELINE_PARAM = new RegExp(`^${ID}$`);

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

// A run carries every stage's profile snapshot and verdict and every attempt with its
// verdict. A six-stage run with some loops measures 300-500 KiB, ten stages with 80
// attempts about 900 KiB, so runs up to 1 MiB are pushed. The log has no bound, so a
// larger run is sent as `stale` and read over REST once per change.
export const RUN_MAX_BYTES = 1024 * 1024;

/** The `pipeline.run` topic definition for LiveHub#define. */
export function pipelineRunTopic(services) {
  return {
    name: "pipeline.run",
    mode: "state",
    maxBytes: RUN_MAX_BYTES,
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

// The run lists and counts. `pipeline.counts[:<projectId>]` is the count of each
// status, the value GET /api/pipeline-run-counts[?projectId=] answers.
// `pipeline.runs:<projectId|*>:<status|*>` is page 1 of the run list, the value
// GET /api/pipeline-runs?page=1 answers with those filters (`*`: none).
// `pipeline.runs.changed[:<projectId>]` sends `changed` on any run change (of that
// project): later pages refetch once. pipelineListsChanged signals all three from the
// engine's onChange and from deletes, only where the changed run is or was listed.
export const RUN_LIST_PARAM = new RegExp(
  `^(?:\\*|${ID}):(?:\\*|${RUN_STATUSES.join("|")})$`,
);

// Page 1 of 20 runs carries each run whole, like the REST list: up to the run's own
// bound; a larger page is sent as `stale` and read over REST once per change.
export const RUN_LIST_MAX_BYTES = RUN_MAX_BYTES;

const listFilter = (param) => {
  const split = param.indexOf(":");
  const projectId = param.slice(0, split),
    status = param.slice(split + 1);
  return {
    projectId: projectId === "*" ? undefined : projectId,
    status: status === "*" ? undefined : status,
  };
};

/**
 * Signals the counts and lists that show a run which was counted as `before`
 * ({projectId, status} or null: new) and is now `after` (the run, or null: deleted).
 */
export function pipelineListsChanged(hub, before, after) {
  if (!hub) return;
  const places = [before, after].filter(Boolean);
  if (!places.length) return;
  const projects = new Set(places.map((place) => place.projectId).filter(Boolean));
  const statuses = new Set(places.map((place) => place.status));
  const ofProject = (param) => param === undefined || projects.has(param);
  const signal = (name, match) => {
    for (const instance of hub.named(name))
      if (match(instance.param)) instance.invalidate();
  };
  signal("pipeline.counts", ofProject);
  signal("pipeline.runs.changed", ofProject);
  signal("pipeline.runs", (param) => {
    const { projectId, status } = listFilter(param);
    return (!projectId || projects.has(projectId)) && (!status || statuses.has(status));
  });
}

/** The `pipeline.counts` topic definition for LiveHub#define. */
export function pipelineCountsTopic(services) {
  return {
    name: "pipeline.counts",
    mode: "state",
    param: PIPELINE_PARAM,
    paramOptional: true,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, projectId) => ({
      counts: services.pipelineRunCounts.counts(projectId),
    }),
  };
}

/** The `pipeline.runs` topic definition for LiveHub#define. */
export function pipelineRunsTopic(services) {
  return {
    name: "pipeline.runs",
    mode: "state",
    maxBytes: RUN_LIST_MAX_BYTES,
    param: RUN_LIST_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, param) =>
      services.pipelines.list({ page: 1, ...listFilter(param) }),
  };
}

/** The `pipeline.runs.changed` signal topic definition for LiveHub#define. */
export function pipelineRunsChangedTopic() {
  return {
    name: "pipeline.runs.changed",
    mode: "signal",
    param: PIPELINE_PARAM,
    paramOptional: true,
    authorize: owner,
    scopeKey: () => "owner",
  };
}
