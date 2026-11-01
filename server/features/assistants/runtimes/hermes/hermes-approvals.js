import { boundPort, reachable, unsupported } from "./hermes-connection.js";

/**
 * The approvals sub-port (agent-runtime.js) over Hermes's approval requests
 * (hermes-approval-queue.js): the pending ones, the owner's answer
 * (`approval.respond`, fenced on the turn's execution generation), and how requests
 * of this connection ended. Hermes keeps no approval history it could be asked for,
 * so history() knows only what this connection saw; after a restart a session
 * attached again lists what still waits, and it is asked anew.
 *
 * Capability gaps: the allowlist (Hermes's `command_allowlist` in config.yaml) is the
 * configuration compiler's to write, so readAllowlist and writeAllowlist refuse
 * (UNSUPPORTED) until the config sub-port owns it, and allowAlwaysPlan always allows
 * once: AgentPier remembers the exact command (exec-decisions.js).
 */
export const hermesApprovals = (supervisor) => boundPort(approvalsOver, supervisor);

function approvalsOver(current) {
  const queue = async () => reachable(current()).approvals;
  return {
    list: async () => (await queue()).list(),
    // The clarify questions of the agent (hermes-questions.js) and their answers.
    questions: async () => reachable(current()).questions.list(),
    answer: async ({ id, answer }) =>
      reachable(current()).questions.answer({ id, answer }),
    resolve: async ({ id, decision }) => (await queue()).resolve({ id, decision }),
    history: async () => (await queue()).history(),
    readAllowlist: async () => {
      await queue();
      throw unsupported("approvals.readAllowlist");
    },
    writeAllowlist: async () => {
      await queue();
      throw unsupported("approvals.writeAllowlist");
    },
    staleAllowlist: () => false,
    allowAlwaysPlan: (payload) => ({
      kind: "once",
      reason: payload?.command ? "pattern" : "unresolved",
    }),
  };
}
