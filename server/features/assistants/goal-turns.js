// Continuation rules for work goals. AgentPier sends a continuation turn on the
// owner's behalf while a goal is open. It is recorded as `kind: "owner"` with a
// `goal` marker (not as a new kind) so every owner-aware path keeps working
// unchanged; the marker is what lets the exclusions below tell it apart.
// A continuation has exactly the rights of its anchor, the owner's latest direct
// turn in the chat, and never more. It is not an owner proof itself: owner
// proofs (mentions, quotes, limits) are read from the anchor's text, never from
// the continuation prompt. Excluded in a continuation: owner-only switches and
// grants, the "Go ahead" consent, and setting or widening a goal.
import { isUserAgent } from "../users/user-access.js";
import { assistantProblem } from "./assistant-validation.js";

export const goalLimits = {
  title: 120,
  done: 1000,
  steps: 4000,
  summary: 1000,
  reason: 1000,
};

export function goalTurn(context) {
  const goal = context?.goal;
  if (
    typeof goal?.id === "string" &&
    typeof goal.anchorRequestId === "string" &&
    typeof goal.title === "string"
  ) {
    return { id: goal.id, anchorRequestId: goal.anchorRequestId, title: goal.title };
  }
  return null;
}

export function directOwnerTurn(context) {
  return (
    (context?.kind === "owner" || context?.kind === "telegram") &&
    !context.forwarded &&
    !goalTurn(context)
  );
}

export function turnKind(context) {
  return goalTurn(context)
    ? (context.result?.kind ?? "goal-continuation")
    : context?.kind;
}

export function goalAgent(agent) {
  return (
    !agent?.archivedAt &&
    !isUserAgent(agent) &&
    (!agent.teamMemberId || agent.lifetime === "permanent")
  );
}

export function goalChat(agent, conversation) {
  return (
    goalAgent(agent) &&
    conversation?.assistantId === agent.id &&
    typeof conversation.userId !== "string" &&
    !conversation.userReleased &&
    !conversation.archivedAt
  );
}

export function ownerSource(teams, request) {
  if (goalTurn(teams.context(request.id))) {
    const goal = goalTurn(teams.context(request.id));
    const anchor = teams.ledger.getRequest(goal.anchorRequestId);
    const context = anchor ? teams.context(anchor.id) : null;
    if (anchor && directOwnerTurn(context))
      return { request: anchor, context, continuation: true };
    return {
      request: { ...request, text: "" },
      context: { kind: "unknown" },
      continuation: true,
    };
  }
  return { request, context: teams.context(request.id), continuation: false };
}

export function refuseInGoalTurn(context, key = "goalOwnerOnly") {
  if (goalTurn(context)) throw assistantProblem(key, 403);
}

export function continuationPrompt(goal) {
  return [
    `This is AgentPier, not the owner. Your goal ${JSON.stringify(goal.title)} in this chat is still open.`,
    `Done means: ${goal.done}`,
    `Your open steps: ${goal.steps || "none noted"}`,
    'Continue with the next step now. When the goal is done, call agentpier_goal with action "done" and a short summary. If you cannot continue without the owner (a decision only they can make, missing access, or another important reason), call agentpier_goal with action "blocked" and the reason. Decide content questions yourself. An approval request is not a block: end your turn, AgentPier continues after the owner decides.',
  ].join("\n");
}
