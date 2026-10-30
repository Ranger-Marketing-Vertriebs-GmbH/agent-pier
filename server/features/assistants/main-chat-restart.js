import { assistantProblem } from "./assistant-validation.js";
import { mainConversation } from "./routine-targets.js";
import { restartScope, runningWork } from "./restart-work.js";
import { freshMainChat, repointDeliveries } from "./main-chat-swap.js";

// Only a lead that is not archived restarts: a team member's chat is its team's.
function restartable(service, assistantId) {
  const agent = service.store.getAssistant(assistantId);
  if (agent.teamMemberId) throw assistantProblem("invalid");
  if (agent.archivedAt) throw assistantProblem("active", 409);
  return agent;
}

// Each person's main chat with the agent: the owner's and every user's.
function mainChats(service, assistantId) {
  const persons = new Set(
    service.store
      .listConversations()
      .filter(
        (c) =>
          c.assistantId === assistantId && c.channel === "agentpier" && !c.archivedAt,
      )
      .map((c) => c.userId ?? null),
  );
  return [...persons]
    .map((userId) => mainConversation(service.store, assistantId, userId))
    .filter(Boolean);
}

/**
 * What restarting the agent's main chat would affect: the persons with a main chat,
 * the members that restart with it and the work it stops. Refuses a team member and an
 * archived agent.
 */
export function restartPreview(service, assistantId) {
  restartable(service, assistantId);
  const { permanent, temporary } = restartScope(service, assistantId);
  return {
    people: mainChats(service, assistantId).length,
    members: { temporary: temporary.length, permanent: permanent.length },
    work: runningWork(service, assistantId),
  };
}

/**
 * Restart main chat, the owner's action: every person's main chat of the lead is
 * archived and replaced by a fresh one with its own native session (main-chat-swap.js),
 * then Telegram, routines and check-ins follow the new main chats. Each person keeps
 * exactly one unarchived main chat even when a swap fails halfway; deliveries are
 * re-pointed then too, and a second restart swaps again.
 */
export async function restartMainChats(service, assistantId) {
  let result;
  try {
    result = await service.admit(async () => {
      restartable(service, assistantId);
      service.requireReady();
      const restartedAt = new Date().toISOString();
      const chats = [];
      for (const conversation of mainChats(service, assistantId)) {
        const next = await freshMainChat(service, conversation);
        chats.push({
          userId: conversation.userId ?? null,
          from: conversation.id,
          to: next.id,
        });
      }
      return { restartedAt, chats };
    });
  } catch (error) {
    await repointDeliveries(service, assistantId).catch(() => {});
    throw error;
  } finally {
    service.changed();
  }
  await repointDeliveries(service, assistantId);
  return result;
}
