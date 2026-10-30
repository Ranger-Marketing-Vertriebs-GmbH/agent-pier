import { assistantProblem } from "./assistant-validation.js";
import { mainConversation } from "./routine-targets.js";
import { restartScope, runningWork, stopWork } from "./restart-work.js";
import { freshMainChat, freshMemberChat, repointDeliveries } from "./main-chat-swap.js";

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
 * and so is the chat of each permanent member, which keeps running (temporary members
 * end). Telegram, routines and check-ins then follow the new chats. All work of the
 * lead and its members stops first (restart-work.js), before and outside the swap's
 * admission: admission is not re-entrant, and the stop steps abort runs and reconcile
 * with the Gateway, which must never hold or wait on it. Each person keeps
 * exactly one unarchived main chat even when a swap fails halfway; deliveries are
 * re-pointed then too, and a second restart swaps again.
 */
export async function restartMainChats(service, assistantId) {
  restartable(service, assistantId);
  service.requireReady();
  const scope = restartScope(service, assistantId);
  const work = await stopWork(service, assistantId, scope);
  // A member's chat is restarted only while it has one; one still provisioning has none.
  const kept = scope.permanent.filter((m) => m.conversationId);
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
      const restarted = [];
      for (const member of kept) {
        await freshMemberChat(service, service.teams.store.member(member.id));
        restarted.push(member.id);
      }
      const ended = scope.temporary.map((m) => m.id);
      return { restartedAt, chats, members: { ended, restarted }, work };
    });
  } catch (error) {
    await repoint(service, assistantId, kept).catch(() => {});
    throw error;
  } finally {
    service.changed();
  }
  await repoint(service, assistantId, kept);
  return result;
}

// Deliveries of the lead and of each restarted member follow their new chats.
async function repoint(service, assistantId, members) {
  await repointDeliveries(service, assistantId);
  for (const member of members) await repointDeliveries(service, member.assistantId);
}
