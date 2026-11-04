// The pure parts of a run's Changes view and a stage's diff tile: when the whole-run
// diff is read again, which answer replaces the shown one, how a failed read reads, and
// the stage diff text as parsed files.
import { parseGitDiff } from "../../../server/features/changes/diff-parse.js";

// The members of the current parallel group that wait for a decision, by id.
const waitingMembers = (run) =>
  Object.entries(run?.memberActions ?? {})
    .filter(([, actions]) => Array.isArray(actions) && actions.length > 0)
    .map(([id]) => id)
    .sort();

/**
 * What of a run changes its diff: its status, current stage, attempt count and the
 * group members waiting for a decision, which its `pipeline.run` push carries, plus the
 * view's manual refresh count. The view reads the diff again when this changes, never
 * on a timer.
 */
export const runDiffKey = (run, refreshes) =>
  JSON.stringify([
    run?.status ?? "",
    run?.currentNodeId ?? "",
    run?.executionLog?.length ?? 0,
    waitingMembers(run),
    refreshes,
  ]);

// The decisions that carry the run's comments: the run's Retry with feedback and Return
// for repair, a group member's Retry with feedback.
const runCarriers = ["feedback", "loop-back"];
const memberCarriers = ["feedback"];

/**
 * Whether a decision that can carry the run's comments waits: `feedback` or `loop-back`
 * in `run.actions`, or `feedback` for a parallel-group member (`run.memberActions`).
 * Run comments can be written only then, since they go out with that decision; a
 * budget, risk or override-only gate keeps them read-only.
 */
export const gateWaits = (run) =>
  (run?.actions ?? []).some((action) => runCarriers.includes(action)) ||
  Object.values(run?.memberActions ?? {}).some(
    (actions) =>
      Array.isArray(actions) && actions.some((action) => memberCarriers.includes(action)),
  );

/**
 * The diff to show after an answer: the shown one while the server's fingerprint is
 * the same (so comments and drafts keep their place), else the answer.
 */
export const keptDiff = (shown, answer) =>
  shown?.fingerprint && shown.fingerprint === answer?.fingerprint ? shown : answer;

/** "gone" (the worktree was removed), "imported" (history only) or "error". */
export function diffFailure(error) {
  if (error?.status !== 409) return "error";
  if (error.code === "PIPELINE_RUN_WORKSPACE_GONE") return "gone";
  if (error.code === "PIPELINE_RUN_IMPORTED") return "imported";
  return "error";
}

/** A stage's `/diff` answer (git diff text) as files for the shared renderer. */
export const stageDiff = (result) => ({
  files: parseGitDiff(result?.diff || ""),
  truncated: result?.truncated === true,
});
