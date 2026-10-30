import { assistantProblem } from "./assistant-validation.js";
import { mainConversation } from "./routine-targets.js";
import { cancelTurns, restartScope, runningWork, stopWork } from "./restart-work.js";
import {
  freshMainChat,
  freshMemberChat,
  moveChannels,
  resyncDeliveries,
} from "./main-chat-swap.js";

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

// The restart of each agent in flight, per service: a second one waits for the first.
const inFlight = new WeakMap();

/**
 * Restart main chat, the owner's action: every person's main chat of the lead is
 * archived and replaced by a fresh one with its own native session (main-chat-swap.js),
 * and so is the chat of each permanent member, which keeps running (temporary members
 * end). Telegram, routines and check-ins then follow the new chats. Restarts of one
 * agent run one after the other.
 */
export function restartMainChats(service, assistantId) {
  const queue = inFlight.get(service) ?? new Map();
  inFlight.set(service, queue);
  const run = (queue.get(assistantId) ?? Promise.resolve()).then(() =>
    restartOnce(service, assistantId),
  );
  const settled = run.then(
    () => {},
    () => {},
  );
  queue.set(assistantId, settled);
  settled.then(() => {
    if (queue.get(assistantId) === settled) queue.delete(assistantId);
  });
  return run;
}

/**
 * One restart. All work of the lead and its members stops first (restart-work.js),
 * before and outside admission: admission is not re-entrant, and the stop steps abort
 * runs and reconcile with the Gateway, which must never hold or wait on it. The swaps
 * and the channel moves run in one admission; each person keeps exactly one
 * unarchived main chat even when a swap fails halfway. Once a swap has committed,
 * turns that slipped into an archived chat are cancelled and routines and check-ins
 * resync, outside admission. A refused restart touches nothing.
 */
async function restartOnce(service, assistantId) {
  restartable(service, assistantId);
  service.requireReady();
  const scope = restartScope(service, assistantId);
  const work = await stopWork(service, assistantId, scope);
  // Read after the stop; a member still provisioning has no chat to restart.
  const kept = restartScope(service, assistantId).permanent.filter(
    (m) => m.conversationId,
  );
  const agents = [assistantId, ...kept.map((m) => m.assistantId)];
  const done = { restartedAt: null, chats: [], restarted: [], archived: new Set() };
  let failure;
  try {
    await service.admit(async () => {
      restartable(service, assistantId);
      service.requireReady();
      done.restartedAt = new Date().toISOString();
      try {
        await swapAll(service, assistantId, kept, done);
      } finally {
        if (done.archived.size) moveAll(service, agents);
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    service.changed();
  }
  const result = {
    restartedAt: done.restartedAt,
    chats: done.chats,
    members: { ended: scope.temporary.map((m) => m.id), restarted: done.restarted },
    work,
  };
  if (done.archived.size) await settle(service, agents, done.archived);
  // A restart that failed after some swaps committed is recorded too, as partial.
  if (!failure || done.archived.size)
    audit(service, assistantId, result, Boolean(failure));
  if (failure) throw failure;
  return result;
}

/**
 * Swaps each person's main chat, then each kept member's, recording each swap in
 * `done` the moment it commits. A swap that failed before committing stops the rest;
 * one that committed and failed after (its note or subscribe) does not, and its error
 * is thrown at the end.
 */
async function swapAll(service, assistantId, kept, done) {
  let failure;
  const swapped = async (swap) => {
    let landed = false;
    try {
      await swap(() => (landed = true));
    } catch (error) {
      if (!landed) throw error;
      failure ??= error;
    }
  };
  for (const conversation of mainChats(service, assistantId))
    await swapped((landed) =>
      freshMainChat(service, conversation, (next) => {
        landed();
        done.archived.add(conversation.id);
        done.chats.push({
          userId: conversation.userId ?? null,
          from: conversation.id,
          to: next.id,
        });
      }),
    );
  for (const { id } of kept) {
    let member, chat;
    try {
      member = service.teams.store.member(id);
      chat = service.store.getConversation(member.conversationId);
    } catch {
      continue; // Its row or its chat went away: nothing to restart.
    }
    await swapped((landed) =>
      freshMemberChat(service, member, () => {
        landed();
        done.archived.add(chat.id);
        done.restarted.push(id);
      }),
    );
  }
  if (failure) throw failure;
}

// Telegram follows the new chats, each agent on its own.
function moveAll(service, agents) {
  for (const id of agents)
    try {
      moveChannels(service, id);
    } catch (error) {
      console.error("Main chat restart: Telegram was not moved:", error?.message);
    }
}

/**
 * After a committed swap: turns that started between the stop and the swap ran on
 * in the chats just archived and are cancelled as stopWork cancels; routines and
 * check-ins resync, each agent on its own. Neither fails the restart: the chats are
 * already swapped, and the Gateway's ready and reconcile repair the jobs.
 */
async function settle(service, agents, archived) {
  await cancelTurns(service, archived).catch((error) =>
    console.error("Main chat restart: a late turn was not cancelled:", error?.message),
  );
  for (const id of agents)
    await resyncDeliveries(service, id).catch((error) =>
      console.error("Main chat restart: deliveries did not resync:", error?.message),
    );
}

function audit(service, assistantId, result, partial) {
  try {
    service.audit?.append({
      action: "assistant.main-chat-restarted",
      resourceType: "assistant",
      resourceId: assistantId,
      outcome: "success",
      source: "user",
      details: {
        chats: result.chats.length,
        members: {
          ended: result.members.ended.length,
          restarted: result.members.restarted.length,
        },
        work: result.work,
        ...(partial && { partial: true }),
      },
    });
  } catch (error) {
    console.error("Main chat restart audit failed:", error?.message);
  }
}
