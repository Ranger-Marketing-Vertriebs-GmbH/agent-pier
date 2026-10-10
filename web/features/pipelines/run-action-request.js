import api from "../../lib/api.js";
import { serverText } from "../../lib/server-messages.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// Decisions taken on the current gate stage; the run header offers everything else.
export const gateActions = ["accept", "feedback", "loop-back", "override"];
// Actions that change or remove the run irreversibly ask for confirmation first.
export const confirmedActions = ["delete", "abort", "override", "create-pr"];

// The engine authorizes actions; publishing additionally needs a Git remote, which
// the run workspace records (`hasRemote` false for a local-only repository).
export const offeredRunActions = (run) =>
  (run.actions || []).filter(
    (action) => action !== "create-pr" || run.workspace?.hasRemote !== false,
  );
// Deleting a run whose worktree holds commits that exist only locally needs a second,
// explicit confirmation; the run branch keeps those commits.
export const localCommitsBlockDelete = (error) =>
  error?.code === "PIPELINE_LOCAL_COMMITS";

// Mirrors the engine's overridePath(): what an override of the active stage does.
function overrideDescription(run) {
  const node = (run?.nodes || []).find((item) => item.id === run.currentNodeId);
  if (node?.status === "failed") return copy.overrideFailedTurn;
  return node?.failReason === "verify-failed"
    ? copy.overrideVerification
    : copy.overrideGate;
}
export function confirmDescription(action, run) {
  return action === "delete-local"
    ? copy.deleteLocalCommits
    : action === "delete"
      ? copy.deleteRun
      : action === "abort"
        ? copy.cancelRun
        : action === "create-pr"
          ? copy.prConfirm
          : overrideDescription(run);
}

// Sends one engine-authorized run action. Resolves true when the run was deleted.
export async function requestRunAction(
  run,
  action,
  { feedback = "", resumeAt = "", confirmLocalCommits = false } = {},
) {
  const base = `/pipeline-runs/${encodeURIComponent(run.id)}`;
  if (action === "delete") {
    await api(base + (confirmLocalCommits ? "?confirmLocalCommits=true" : ""), "DELETE");
    return true;
  }
  if (action === "reconcile") {
    const status = await api(base + "/verdict-status");
    if (!status.present) throw Error(serverText(status.reason) || copy.verdictMissing);
  }
  const suffix =
    action === "retry"
      ? "/retry-stage"
      : action === "create-pr"
        ? "/pull-request"
        : action === "abort" && run.status === "running"
          ? "/cancel"
          : "/gate";
  await api(
    base + suffix,
    "POST",
    suffix === "/gate"
      ? {
          action,
          ...(["feedback", "loop-back"].includes(action) ? { feedback } : {}),
          ...(action === "wait-for-reset" && resumeAt
            ? { resumeAt: new Date(resumeAt).toISOString() }
            : {}),
        }
      : {},
  );
  return false;
}
