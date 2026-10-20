import { problem } from "../../lib/storage.js";
import {
  requireResource,
  requirePipeline,
  requireRun,
  visible,
  pageItems,
} from "./tool-policy.js";

// MCP access to a project's run queue. Queueing is a deferred start: queue_add runs
// every check of run_start when the item is added and reserves the run id in the start
// registry, so the run the queue starts later belongs to this grant (run_get,
// run_cancel). Removing an item needs runs:cancel and, like run_cancel, the grant that
// queued it.

const own = (item, grant) =>
  item.source?.kind === "mcp" && item.source.grantId === grant.id;

/** An item as a client sees it; the task text only for its own items. */
function summary(item, grant) {
  return {
    id: item.id,
    projectId: item.projectId,
    pipelineId: item.pipelineId,
    pipelineName: item.pipelineName,
    state: item.state,
    externalRef: item.externalRef,
    baseBranch: item.baseBranch,
    tokenBudget: item.tokenBudget,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    ...(item.error ? { error: item.error } : {}),
    ...(own(item, grant) ? { task: item.task } : {}),
    // A started item's run has the item's id.
    runId: item.state === "started" ? item.id : null,
    ...(item.run ? { runStatus: item.run.status } : {}),
  };
}

function replayQueued(tools, grant, requestId, input) {
  const previous = tools.requests.get(grant.id, requestId, input);
  if (!previous) return;
  const item = tools.services.pipelineQueue.find(previous.runId);
  if (item)
    return {
      item: summary(tools.services.pipelineQueue.item(item.projectId, item.id), grant),
      replayed: true,
    };
  let run;
  try {
    run = tools.services.pipelines.get(previous.runId);
  } catch (error) {
    if (error.status !== 404) throw error;
    throw problem(
      "This queue item was removed or never confirmed. Inspect AgentPier before submitting a new request ID.",
      409,
    );
  }
  // The item started its run and left the queue since.
  requireRun(grant, run, previous);
  return { item: null, run: tools.summary(run), replayed: true };
}

export const queueTools = {
  async queue_add(tools, args, grant, resolveGrant) {
    const { pipelineId, projectId, task, baseBranch, tokenBudget, externalRef } = args;
    const input = {
      queued: true,
      pipelineId,
      projectId,
      task,
      baseBranch: baseBranch || null,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      externalRef: externalRef || null,
    };
    const checked = await tools.authorizeStart(args, grant, resolveGrant, input, (...a) =>
      replayQueued(tools, ...a),
    );
    if (checked.previous) return checked.previous;
    ({ grant } = checked);
    const receipt = tools.requests.reserve(grant.id, args.requestId, input);
    const item = tools.services.pipelineQueue.add(
      projectId,
      { pipelineId, task, baseBranch, tokenBudget, externalRef },
      {
        id: receipt.runId,
        source: { kind: "mcp", grantId: grant.id, clientId: grant.clientId },
      },
    );
    tools.audit("pipeline.created", "pipeline", item.id, grant, projectId, {
      kind: "queue",
    });
    return { item: summary(item, grant), replayed: false };
  },
  queue_list(tools, args, grant) {
    requireResource(grant, "projectIds", args.projectId);
    const definitions = tools.services.pipelineDefinitions;
    const items = tools.services.pipelineQueue
      .view(args.projectId)
      .items.filter((item) =>
        grant.ownedRunsOnly
          ? own(item, grant)
          : own(item, grant) ||
            visible(() =>
              requirePipeline(
                grant,
                definitions.getPipeline(item.pipelineId),
                definitions,
              ),
            ),
      );
    return pageItems(
      items.map((item) => summary(item, grant)),
      args,
    );
  },
  queue_remove(tools, args, grant) {
    requireResource(grant, "projectIds", args.projectId);
    const queue = tools.services.pipelineQueue;
    const item = queue.find(args.itemId);
    if (!item || item.projectId !== args.projectId)
      throw problem("Queue item not found.", 404);
    if (!grant.allResources && !own(item, grant))
      throw problem("This grant did not queue that item.", 403);
    if (item.state === "started")
      throw problem(
        "This item already started its run; cancel the run with run_cancel.",
        409,
      );
    if (item.state === "starting")
      throw problem("This item is being started. Read it again shortly.", 409);
    queue.remove(args.projectId, item.id, { waitingOnly: true });
    tools.audit("pipeline.deleted", "pipeline", item.id, grant, args.projectId, {
      kind: "queue",
    });
    return { removed: true, id: item.id };
  },
};
