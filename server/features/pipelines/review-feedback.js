// The open review comments of a run, sent with a gate's feedback ("Retry with
// feedback", "Return for repair", a group member's feedback). The browser only asks
// with `review: true`; the batch text is built here from the stored comments.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  REVIEW_FEEDBACK_LIMIT,
  combineFeedback,
  feedbackBytes,
  formatReviewBatch,
  reviewEntries,
} from "../changes/review-batch.js";
import { runDiff } from "./run-diff.js";

const CARRYING = new Set(["feedback", "loop-back"]);

// The run's whole diff; a failed read leaves every comment outdated.
async function currentFiles(engine, run) {
  try {
    return (await runDiff(engine, run)).files;
  } catch {
    return null;
  }
}

/**
 * The gate input with the open run comments added to its feedback, and the ids of
 * the comments it carries. Refuses (409 PIPELINE_FEEDBACK_TOO_LARGE) a combined
 * text above REVIEW_FEEDBACK_LIMIT bytes instead of cutting it.
 * @returns {Promise<{ input: object, sent: string[] }>}
 */
export async function withReviewFeedback(engine, run, input) {
  const store = engine.reviewComments;
  if (input?.review !== true || !CARRYING.has(input.action) || !store)
    return { input, sent: [] };
  // Malformed free text is the gate action's to refuse.
  if (input.feedback != null && typeof input.feedback !== "string")
    return { input, sent: [] };
  const { comments } = store.list({ kind: "run", id: run.id });
  if (!comments.some((c) => c.status === "open")) return { input, sent: [] };
  const files = await currentFiles(engine, run);
  // Run comments carry an empty workspace: their paths are relative to the run's.
  const entries = reviewEntries(comments, files ? new Map([["", files]]) : new Map());
  const feedback = combineFeedback(input.feedback ?? "", formatReviewBatch(entries));
  if (feedbackBytes(feedback) > REVIEW_FEEDBACK_LIMIT)
    throw Object.assign(problem(serverMessages.changes.reviewFeedbackTooLarge, 409), {
      code: "PIPELINE_FEEDBACK_TOO_LARGE",
    });
  return { input: { ...input, feedback }, sent: entries.map((e) => e.id) };
}

/**
 * Marks the carried comments as sent once the gate action ran. Nothing carried
 * names no batch; a comment file that cannot be written does not fail the action.
 */
export function markReviewSent(engine, id, sent) {
  if (sent.length === 0) return;
  try {
    engine.reviewComments.markSent({ kind: "run", id }, sent);
  } catch (error) {
    engine.recordError(error);
  }
}
