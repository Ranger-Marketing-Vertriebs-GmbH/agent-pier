import { allowAlwaysPlan } from "./exec-allowlist-policy.js";
import { boundPort } from "./openclaw-agents.js";
import { openClawQuestions } from "./openclaw-questions.js";

// OpenClaw refuses exec.approvals.set over a stale base hash with INVALID_REQUEST
// naming the change; a fresh read fixes that one refusal, no other.
const staleAllowlist = (error) =>
  error?.code === "INVALID_REQUEST" &&
  /changed since last load/.test(error.remoteMessage);

// OpenClaw checks the caller's access again as it commits an answer and refuses the
// commit when its access revision moved since the answer arrived; session changes
// move it, another run ending is enough. It reports that refusal like a request it
// no longer has: INVALID_REQUEST "unknown or expired approval id", details.reason
// APPROVAL_NOT_FOUND. Nothing was committed and the request still waits (verified
// on 2026.11.6: exec.approval.list still names it, approval.history has no
// record). So a refused answer whose request is still in exec.approval.list is
// sent again; one that is not listed is gone, and the refusal stands. Bounded,
// because every round is a Gateway read and a write.
const answerRounds = 4;
const notFound = (error) =>
  error?.answered === true && error.detailReason === "APPROVAL_NOT_FOUND";
async function answerPending(call, { id, decision }) {
  for (let round = 1; ; round++) {
    try {
      return await call("exec.approval.resolve", { id, decision });
    } catch (error) {
      if (round >= answerRounds || !notFound(error)) throw error;
      // A list that cannot be read tells nothing: the refusal stands.
      const pending = await call("exec.approval.list", {}).catch(() => null);
      if (!Array.isArray(pending) || !pending.some((item) => item?.id === id))
        throw error;
    }
  }
}

/**
 * The approvals sub-port (agent-runtime.js) over OpenClaw's exec approvals: the
 * pending requests (`exec.approval.list`), the owner's answer (sent again while
 * OpenClaw refuses it for a request it still lists, `answerPending`), the history of
 * how requests ended, and the exec allowlist file (`exec.approvals.get/set`, keyed by
 * runtime agent id). Requests and their end arrive as run events (events sub-port,
 * `approval.requested`/`approval.resolved`). Answers are OpenClaw's own. The
 * questions agents ask with `ask_user` are openclaw-questions.js's.
 * `allowAlwaysPlan` is OpenClaw's side of "Always allow" for a request it withheld
 * it from (exec-allowlist-policy.js).
 */
export const openClawApprovals = (supervisor, clientOf) =>
  boundPort(approvalsOver, supervisor, clientOf);

function approvalsOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    list: () => call("exec.approval.list", {}),
    resolve: (answer) => answerPending(call, answer),
    history: () => call("approval.history", {}),
    readAllowlist: () => call("exec.approvals.get", {}),
    writeAllowlist: ({ baseHash, file }) =>
      call("exec.approvals.set", { baseHash, file }),
    staleAllowlist,
    allowAlwaysPlan: (payload, options) => allowAlwaysPlan(payload, options),
    // The questions of the agents' ask_user tool (openclaw-questions.js).
    ...openClawQuestions(call),
  };
}
