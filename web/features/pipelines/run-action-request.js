import api from "../../lib/api.js";
import { serverText } from "../../lib/server-messages.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// Decisions taken on the current gate stage; the run header offers everything else.
export const gateActions = ["accept", "feedback", "loop-back", "override"];
// Actions that change or remove the run irreversibly ask for confirmation first.
export const confirmedActions = ["delete", "abort", "override", "create-pr"];

export function confirmDescription(action) {
  return action === "delete"
    ? copy.deleteRun
    : action === "abort"
      ? copy.cancelRun
      : action === "create-pr"
        ? copy.prConfirm
        : copy.overrideRun;
}

// Sends one engine-authorized run action. Resolves true when the run was deleted.
export async function requestRunAction(
  run,
  action,
  { feedback = "", resumeAt = "" } = {},
) {
  const base = `/pipeline-runs/${encodeURIComponent(run.id)}`;
  if (action === "delete") {
    await api(base, "DELETE");
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
