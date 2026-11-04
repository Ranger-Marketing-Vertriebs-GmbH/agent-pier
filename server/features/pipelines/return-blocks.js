// Why a finished run cannot be sent back to a stage, or null when it can. Each reason
// names a sentence in the pipelines catalog (`returnBlocked`), so the browser shows why.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * @typedef {"imported"|"not-finished"|"cancelled"|"no-workspace"|"workspace-gone"|
 *   "pr-merged"|"pr-closed"|"pr-armed"|"pr-unknown"|"sequence-watching"} ReturnBlock
 */

const PR_BLOCKS = { merged: "pr-merged", closed: "pr-closed", armed: "pr-armed" };

/**
 * The first reason, in this order, that keeps the run where it is.
 * @returns {Promise<ReturnBlock|null>}
 */
export async function returnBlock(engine, run) {
  if (run.imported?.historyOnly) return "imported";
  if (run.status === "cancelled") return "cancelled";
  if (!["completed", "failed"].includes(run.status)) return "not-finished";
  if (!run.workspace) return "no-workspace";
  try {
    await engine.workspace.validate(run.workspace);
  } catch {
    return "workspace-gone";
  }
  // The run continues on its pull request's branch: only while that is open and
  // nothing is about to merge it.
  if (run.pullRequestUrl) {
    let state;
    try {
      state = await engine.workspace.pullRequestState({
        workspace: run.workspace,
        url: run.pullRequestUrl,
      });
    } catch {
      return "pr-unknown";
    }
    if (PR_BLOCKS[state]) return PR_BLOCKS[state];
    if (state !== "open") return "pr-unknown";
  }
  if (engine.sequenceWatch?.(run.id) === true) return "sequence-watching";
  return null;
}

/** The 409 for a blocked return, with its reason and the reason's own sentence. */
export function returnBlocked(reason) {
  const key = reason.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  return Object.assign(problem(serverMessages.pipelines.returnBlocked[key], 409), {
    code: "PIPELINE_RETURN_BLOCKED",
    reason,
  });
}
