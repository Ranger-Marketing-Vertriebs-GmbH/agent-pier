import { assistantProblem } from "./assistant-validation.js";
import { isUserAgent } from "../users/user-access.js";

// The owner decided (AGENTPIER-276, after AGENTPIER-274 for shared files): his own
// agents are not blocked from their work by the origin of the run. Every run of the
// owner's own chat with an agent that serves no restricted users works with the
// agent's standing grants for its project folders and memory: his own turns,
// check-ins and reminders, and the runs OpenClaw starts without a turn (its
// follow-up after a background command, a heartbeat). What came from someone else
// keeps its limits: forwarded content, members' reports and answers, a restricted
// user's chat, a user agent and the agent's Telegram bot for other people, whose
// sessions are no owner chat. Shell, SSH, mail, secrets and other people keep their
// own approvals and origin rules (agent-ssh-origin.js, mail/agent-mail-origin.js).

/** Whether `conversation` is the owner's own chat of an active agent that is no user agent. */
export function ownerChat(agent, conversation) {
  return (
    !!agent &&
    !agent.archivedAt &&
    !isUserAgent(agent) &&
    conversation?.assistantId === agent.id &&
    !conversation.userId &&
    !conversation.userReleased
  );
}

// Turn origins whose text the owner did not write: forwarded content, what members,
// restricted users or other agents send, and a remote host's output (SSH and SFTP
// results keep their own origin rules, agent-ssh-origin.js).
const foreignKinds = new Set([
  "ssh-result",
  "sftp-result",
  "user",
  "team-member",
  "lead-request",
  "member-report",
  "member-routine",
  "member-hook",
  "peer-result",
]);
/** Whether a turn's recorded origin is content from someone else than the owner. */
export const foreignOrigin = (origin) =>
  !!origin?.forwarded || foreignKinds.has(origin?.kind);

/**
 * Whether a bound turn of `conversation` works for the owner with the agent's
 * standing grants: a turn of his own chat with his own agent (no task member) whose
 * content is not someone else's. A memory step keeps its own narrow rules
 * (memory-step-tools.js).
 */
export const ownerTurn = (agent, conversation, origin) =>
  ownerChat(agent, conversation) &&
  !agent.teamMemberId &&
  origin?.kind !== "memory-step" &&
  !foreignOrigin(origin);

/**
 * A run of the owner's own chat without a turn (TeamBridge: no bound attempt, no
 * hook or routine run, no unresolved turn): `{ agent, conversation }`, or null. The
 * chat's latest turn must not be someone else's content, so a run it started never
 * acts on it.
 */
export function ownerRun(bridge, { agentId, sessionKey, runId }) {
  try {
    const agent = bridge.agentOf(agentId);
    const { store, ledger } = bridge.assistants;
    const conversation = store.conversationOfSession(sessionKey);
    if (!ownerChat(agent, conversation) || agent.teamMemberId) return null;
    // A turn whose send is still unresolved may be this very run: it proves itself
    // (run-confirmation.js), or waits (TURN_UNCONFIRMED).
    if (bridge.bound?.(sessionKey, true).length) return null;
    // Never a ledger turn's own run, which its turn governs (also once reviewed).
    if (ledger.attemptForRun?.(runId)) return null;
    const latest = ledger.latestRequest(conversation.id);
    if (latest && foreignOrigin(bridge.teams?.store?.context?.(latest.id))) return null;
    return { agent, conversation };
  } catch {
    return null;
  }
}

/** What an owner run reaches through the bridge: project folders and its catalog. */
export const ownerRunActions = new Set(["workspace"]);

/** A ticket's binding for an owner run (TeamBridge.prepare), or null. */
export function ownerRunBinding(bridge, input) {
  if (!ownerRunActions.has(input.action)) return null;
  const run = ownerRun(bridge, input);
  return run && { conversationId: run.conversation.id };
}

/** Re-checks an owner run's ticket on every step (TeamBridge.valid); throws. */
export function assertOwnerRun(bridge, record) {
  if (
    !ownerRunActions.has(record.action) ||
    ownerRun(bridge, record)?.conversation.id !== record.ownerRun.conversationId
  )
    throw assistantProblem("invalid", 403);
  return record;
}

/**
 * A native write of an owner run (TeamBridge.writeAllowed): allowed, and audited
 * with its path (never content).
 */
export function ownerRunWrite(bridge, input) {
  const run = ownerRun(bridge, input);
  if (!run) return false;
  try {
    bridge.assistants.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: run.agent.id,
      source: "system",
      outcome: "success",
      details: {
        kind: "native-write",
        tool: input.toolName,
        filePath: input.path,
        via: "agent-run",
      },
    });
  } catch (error) {
    console.error("Agent run write audit failed:", error?.message);
  }
  return true;
}
