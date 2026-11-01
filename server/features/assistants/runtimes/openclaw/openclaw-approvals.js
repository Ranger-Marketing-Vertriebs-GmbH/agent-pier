import { allowAlwaysPlan } from "./exec-allowlist-policy.js";
import { boundPort } from "./openclaw-agents.js";

// OpenClaw refuses exec.approvals.set over a stale base hash with INVALID_REQUEST
// naming the change; a fresh read fixes that one refusal, no other.
const staleAllowlist = (error) =>
  error?.code === "INVALID_REQUEST" &&
  /changed since last load/.test(error.remoteMessage);

/**
 * The approvals sub-port (agent-runtime.js) over OpenClaw's exec approvals: the
 * pending requests (`exec.approval.list`), the owner's answer, the history of how
 * requests ended, and the exec allowlist file (`exec.approvals.get/set`, keyed by
 * runtime agent id). Requests and their end arrive as run events (events sub-port,
 * `approval.requested`/`approval.resolved`). Answers are OpenClaw's own.
 * `allowAlwaysPlan` is OpenClaw's side of "Always allow" for a request it withheld
 * it from (exec-allowlist-policy.js).
 */
export const openClawApprovals = (supervisor, clientOf) =>
  boundPort(approvalsOver, supervisor, clientOf);

function approvalsOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    list: () => call("exec.approval.list", {}),
    resolve: ({ id, decision }) => call("exec.approval.resolve", { id, decision }),
    history: () => call("approval.history", {}),
    readAllowlist: () => call("exec.approvals.get", {}),
    writeAllowlist: ({ baseHash, file }) =>
      call("exec.approvals.set", { baseHash, file }),
    staleAllowlist,
    allowAlwaysPlan: (payload, options) => allowAlwaysPlan(payload, options),
  };
}
