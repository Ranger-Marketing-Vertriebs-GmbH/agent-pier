import { assistantProblem } from "./assistant-validation.js";
import { createGatewaySession } from "./session-create.js";
import { mainConversation } from "./routine-targets.js";
import { isUserAgent, memberLevel } from "../users/user-access.js";

/**
 * The main chat of one person with an agent, created on first use: the owner's
 * (`userId` null) or a restricted user's. Each person has her own native session, so
 * two users of a shared agent never share a transcript; the agent's memory stays one.
 * The owner has no chat with a user's own agent, and a user only with agents that
 * serve her. Callers hold admission.
 */
export async function openMainConversation(service, assistantId, { turn, userId }) {
  const agent = service.store.getAssistant(assistantId);
  const ownUserAgent = isUserAgent(agent) && agent.userAccess.mode === "own";
  if (userId === null ? ownUserAgent : !memberLevel(agent, userId))
    throw assistantProblem("notFound", 404);
  const existing = mainConversation(service.store, assistantId, userId);
  if (existing) return existing;
  const context = userId === null ? { kind: "owner" } : { kind: "user", userId };
  if (turn) service.teams?.assertMemberTurn(assistantId, context);
  else if (agent.archivedAt) throw assistantProblem("active", 409);
  service.requireReady();
  await service.config.apply(assistantId);
  const assistant = service.store.getAssistant(assistantId);
  const label = `AgentPier ${assistant.id}${userId === null ? "" : ` ${userId}`}`;
  const created = await createGatewaySession(
    service.runtime.client,
    { agentId: assistant.runtimeAgentId, label },
    service.sessionCreate,
  );
  if (!created.key) throw assistantProblem("unavailable", 503);
  const conversation = service.store.saveConversation({
    assistantId,
    runtimeSessionKey: created.key,
    ...(userId === null ? {} : { userId }),
  });
  await service.runtime.client.call("sessions.messages.subscribe", { key: created.key });
  service.changed();
  return conversation;
}
