import { assistantProblem } from "./assistant-validation.js";
import { familyChanged } from "./model-family.js";
import { effectiveModel, temporaryMember } from "./team-presentation.js";
import {
  freshMainChat,
  freshMemberChat,
  mainChats,
  moveChannels,
  resyncDeliveries,
} from "./main-chat-swap.js";
import { deferredSwaps } from "./deferred-swaps.js";

/**
 * A model switch: when an agent moves to another model family (or the owner asks for
 * it), each chat it continues in is replaced by a fresh one (main-chat-swap.js) and
 * the archived chat names it as its successor, so late results follow
 * (chat-successor.js). Unlike Restart main chat nothing stops: no work is cancelled, no
 * member ends, other agents are untouched.
 */

const sameModel = (a, b) =>
  a?.connectionId === b?.connectionId && a?.modelId === b?.modelId;

/**
 * What saving `after` over `before` (assistant records) switches, or null when the
 * model stays. `agents` are the agent and each temporary member that follows its
 * model; `fresh` is the owner's `freshChats`, by default whether the family changes.
 * `followLead` puts a temporary member back on its lead's model. Refuses a
 * `freshChats` that is not a boolean.
 */
export function planSwitch(service, before, given, options) {
  const { freshChats, followLead } = options || {};
  if (freshChats !== undefined && typeof freshChats !== "boolean")
    throw assistantProblem("invalid");
  const after =
    followLead === true ? { ...given, model: leadModel(service, before) } : given;
  if (!after?.model || sameModel(before.model, after.model)) return null;
  const followers = before.teamMemberId
    ? []
    : service.store
        .listAssistants()
        .filter(
          (a) =>
            a.parentAssistantId === before.id &&
            temporaryMember(a) &&
            !a.ownModel &&
            !a.archivedAt &&
            !sameModel(effectiveModel(a, before), effectiveModel(a, after)),
        );
  const fresh =
    freshChats ?? familyChanged(before.model, after.model, service.models.connections);
  return {
    agents: [before.id, ...followers.map((a) => a.id)],
    fresh,
    from: before.model,
    to: after.model,
  };
}

// The model of a temporary member's lead, the one it follows; none when unreadable.
function leadModel(service, member) {
  if (!temporaryMember(member)) return member.model;
  try {
    return service.store.getAssistant(member.parentAssistantId).model;
  } catch {
    return member.model;
  }
}

// The conversations with a turn under way.
function pendingChats(service) {
  const ids = new Set();
  for (const attempt of service.ledger.pending()) {
    try {
      ids.add(service.ledger.getRequest(attempt.requestId).conversationId);
    } catch {
      /* A request that went away meanwhile. */
    }
  }
  return ids;
}

/** Whether a turn of the agent is under way in any of its chats. */
export const agentTurnPending = (service, assistantId) =>
  [...pendingChats(service)].some(
    (id) => service.store.getConversation(id).assistantId === assistantId,
  );

/**
 * Whether no turn runs in the chat: none under way, no message queued, no approval
 * waiting, no requested summary running. Work that only reports into the chat later
 * (team requests, owed follow-ups) does not hold a swap back: it follows the
 * successor.
 */
export function chatFree(service, conversationId) {
  if (pendingChats(service).has(conversationId)) return false;
  if (service.queued?.get(conversationId)) return false;
  const awaiting = service.workflows?.store?.awaiting?.() || [];
  if (awaiting.some((a) => a.conversationId === conversationId)) return false;
  return !service.longChats?.running.has(conversationId);
}

// The model as the owner reads it; one that no longer resolves keeps its id.
async function modelName(service, model) {
  try {
    const lease = await service.models.resolve(model);
    lease.release?.();
    return String(lease.display?.model || model.modelId);
  } catch {
    return String(model?.modelId || model?.connectionId);
  }
}

// The chats of one agent the switch replaces: each person's main chat, or for a team
// member its own chat (`member` is its row). A member without a chat yet has none.
function chatsOf(service, assistantId) {
  try {
    const agent = service.store.getAssistant(assistantId);
    if (!agent.teamMemberId) return mainChats(service, assistantId).map((c) => ({ c }));
    const member = service.teams.store.member(agent.teamMemberId);
    const c = service.store.getConversation(member.conversationId);
    return c.archivedAt ? [] : [{ c, member }];
  } catch {
    return []; // The agent, its row or its chat went away: nothing to swap.
  }
}

/**
 * Swaps one chat of `assistantId` with the switch's note (`details`, both model
 * names): a team member's own chat when `memberId` names its row, else a person's
 * main chat. `landed(next)` runs once the swap committed (main-chat-swap.js); a
 * failure before it leaves the chat as it was. Callers hold admission.
 */
export function swapChat(service, { conversation, memberId, details }, landed) {
  const options = { reason: "model-switched", details, successor: true };
  return memberId
    ? freshMemberChat(service, service.teams.store.member(memberId), landed, {
        ...options,
        main: conversation.main === true,
      })
    : freshMainChat(service, conversation, landed, { ...options, main: true });
}

/**
 * Swaps the chats of every agent in `plan` that are free now and returns them, each
 * `{ assistantId, userId, from, to }`, with the ids of the chats that are not free in
 * `deferred`: deferred-swaps.js holds those and swaps each once it is free. A swap
 * that failed before it committed leaves its chat as it was and is deferred too; one
 * that failed after (its note or subscribe) is logged, its chat already replaced. The
 * model is saved already, so nothing here throws. Callers hold admission, unless
 * `hold` defers every chat without swapping any (no admission needed).
 */
export async function swapNow(service, plan, { hold = false } = {}) {
  const result = { chats: [], deferred: [] };
  if (!plan?.fresh) return result;
  const details = {
    from: await modelName(service, plan.from),
    to: await modelName(service, plan.to),
  };
  for (const assistantId of plan.agents) {
    let swapped = false;
    for (const { c, member } of chatsOf(service, assistantId)) {
      const swap = { assistantId, memberId: member?.id, details };
      const defer = () => {
        result.deferred.push(c.id);
        deferredSwaps(service).add(c.id, swap);
      };
      if (hold || !chatFree(service, c.id)) {
        defer();
        continue;
      }
      const landed = (next) => {
        swapped = true;
        result.chats.push({
          assistantId,
          userId: c.userId ?? null,
          from: c.id,
          to: next.id,
        });
      };
      try {
        await swapChat(service, { ...swap, conversation: c }, landed);
      } catch (error) {
        if (!result.chats.some((s) => s.from === c.id)) defer();
        console.error("Model switch: a chat was not swapped:", error?.message);
      }
    }
    if (swapped) moveChannelsOf(service, assistantId);
  }
  return result;
}

/** Points the agent's Telegram channels at its new main chats; logs a failure. */
export function moveChannelsOf(service, assistantId) {
  try {
    moveChannels(service, assistantId);
  } catch (error) {
    console.error("Model switch: Telegram was not moved:", error?.message);
  }
}

/**
 * The memory review after a switch with fresh chats; added by memory-review.js
 * (Task 6). Until then it does nothing.
 */
export async function reviewAfterSwitch() {}

/**
 * After the swaps, outside admission: routines and check-ins of each agent follow its
 * new main chat, then the memory review starts. Never throws: the switch is saved.
 */
export async function afterSwitch(service, plan, result) {
  if (!plan?.fresh) return;
  const moved = new Set(result?.chats.map((c) => c.assistantId));
  for (const id of moved)
    await resyncDeliveries(service, id).catch((error) =>
      console.error("Model switch: deliveries did not resync:", error?.message),
    );
  await reviewAfterSwitch(service, plan, result).catch((error) =>
    console.error("Model switch: the memory review did not start:", error?.message),
  );
}

/**
 * Runs afterSwitch and returns the saved `profile`, with `freshChats` (the swapped
 * and deferred chats) when the switch starts fresh chats.
 */
export async function switched(service, plan, result, profile) {
  await afterSwitch(service, plan, result);
  return plan?.fresh ? { ...profile, freshChats: result } : profile;
}
