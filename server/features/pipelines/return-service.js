// Return to stage: the owner sends a finished run back to a stage it ran, with free
// text and the run's open review notes as the repair instruction. There is no queue
// item: a project whose run slots are all taken answers "busy, try again".
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { REVIEW_FEEDBACK_LIMIT, feedbackBytes } from "../changes/review-batch.js";
import { occupiedSlots } from "./queue-policy.js";
import { markReviewSent, withReviewFeedback } from "./review-feedback.js";
import { returnBlock, returnBlocked } from "./return-blocks.js";
import { reopenAtStage, returnableStages } from "./return-to-stage.js";
import { runId } from "./run-store.js";

function openComments(engine, id) {
  const comments = engine.reviewComments?.list({ kind: "run", id })?.comments ?? [];
  return comments.filter((c) => c.status === "open").length;
}

/**
 * What the Return to stage dialog offers: whether the run can go back (or why not),
 * the stages it ran, and how many open review notes would go along.
 * @returns {Promise<{ available: boolean, reason: string|null,
 *   stages: { id: string, name: string }[], openComments: number }>}
 */
export async function returnOptions(engine, id) {
  const run = engine.store.get(id);
  const reason = await returnBlock(engine, run);
  return {
    available: reason === null,
    reason,
    stages: returnableStages(run),
    openComments: openComments(engine, id),
  };
}

// A project with a run queue takes the return only into a free slot of its limit; a
// run without a registered project goes back at once.
function slotFree(queue, run) {
  const projectId = run.projectId ?? run.expectedProjectId;
  if (!queue || !projectId || !queue.exists(projectId)) return true;
  const settings = queue.settings(projectId);
  return (
    occupiedSlots({
      projectId,
      items: queue.store.list(projectId),
      runs: queue.activeRuns(),
      settings,
    }) < settings.limit
  );
}

/**
 * Sends the run back to `nodeId`. A repeated `requestId` answers the run as it is.
 * The open notes are marked sent only once the stage was relaunched.
 * @returns {Promise<{ run: object }>}
 */
export async function requestReturn(engine, id, body, { queue } = {}) {
  const { nodeId, feedback = "", review = false, requestId } = body ?? {};
  runId(requestId);
  if (typeof feedback !== "string")
    throw problem(serverMessages.pipelines.invalidLoopFeedback);
  let audited = null;
  await engine.lock(id, async () => {
    const run = engine.store.get(id);
    if ((run.returns ?? []).some((r) => r.requestId === requestId)) return;
    const reason = await returnBlock(engine, run);
    if (reason) throw returnBlocked(reason);
    if (!returnableStages(run).some((stage) => stage.id === nodeId))
      throw problem(serverMessages.pipelines.returnStageUnknown, 400);
    const { input, sent } = await withReviewFeedback(engine, run, {
      action: "loop-back",
      feedback,
      review: review === true,
    });
    const note = input.feedback ?? "";
    if (!note.trim()) throw problem(serverMessages.pipelines.returnNoteRequired, 400);
    if (feedbackBytes(note) > REVIEW_FEEDBACK_LIMIT)
      throw Object.assign(problem(serverMessages.changes.reviewFeedbackTooLarge, 409), {
        code: "PIPELINE_FEEDBACK_TOO_LARGE",
      });
    if (!slotFree(queue, run))
      throw Object.assign(problem(serverMessages.pipelines.returnBusy, 409), {
        code: "PIPELINE_RETURN_BUSY",
      });
    await reopenAtStage(engine, run, { nodeId, note, requestId });
    markReviewSent(engine, id, sent);
    audited = { kind: "return", stageId: nodeId, comments: sent.length };
  });
  // Sending a finished run back is the owner's decision on that stage; keep a trace.
  if (audited)
    engine.audit?.append({
      action: "pipeline.updated",
      resourceType: "pipeline",
      resourceId: id,
      source: "user",
      outcome: "success",
      details: audited,
    });
  return { run: engine.get(id) };
}
