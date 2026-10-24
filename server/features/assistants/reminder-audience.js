import { assistantProblem } from "./assistant-validation.js";
import { canPairTelegram, isUserAgent, memberLevel } from "../users/user-access.js";
import { refuseInGoalTurn } from "./goal-turns.js";

/**
 * Whom reminders, routines and check-ins belong to. On a shared agent each person's
 * bindings are her own: they deliver into her main chat and to her devices, and only
 * she sees and changes them. A binding without `userId` is the owner's.
 */

/** The binding's person: a user's id, or null for the owner. */
export const audienceOf = (binding) =>
  typeof binding?.userId === "string" ? binding.userId : null;

/**
 * The push audience of a binding's results (notification-service.js), as fields to
 * spread into a notice: a user's devices, or none for the owner's (the default).
 */
export const pushAudience = (binding) =>
  audienceOf(binding) ? { audience: { kind: "user", userId: binding.userId } } : {};

/**
 * The agent's one person: the user of her own agent, otherwise the owner (null). Its
 * check-ins go to her, and the owner's settings show her bindings (he reads them
 * only under her opt-in, owner-content-guard.js).
 */
export const agentPerson = (agent) =>
  isUserAgent(agent) && agent.userAccess.mode === "own"
    ? agent.userAccess.members[0].userId
    : null;

/**
 * Whose bindings a turn may manage with the agent's reminder or routine tool: the
 * person whose chat it is, on a direct turn only. A user's turn writes only while she
 * belongs to the agent at "personalize" or higher. A goal turn (goal-turns.js) only
 * lists them: changes, "May write" and Telegram need the owner's own message.
 */
export function turnAudience(agent, conversation, origin, write) {
  if (write) refuseInGoalTurn(origin);
  if (!["owner", "telegram", "user"].includes(origin?.kind) || origin.forwarded)
    throw assistantProblem("invalid", 403);
  const userId = typeof conversation.userId === "string" ? conversation.userId : null;
  if (origin.kind === "user" && origin.userId !== userId)
    throw assistantProblem("invalid", 403);
  if (userId === null) return null;
  const level = memberLevel(agent, userId);
  if (!level || (write && level === "chat")) throw assistantProblem("invalid", 403);
  return userId;
}

/** The binding `bindingId` of agent `id` when it is `userId`'s (null: the owner's). */
export function boundTo(bindings, id, bindingId, userId) {
  const binding = bindings.get(bindingId);
  if (binding.assistantId !== id || audienceOf(binding) !== userId)
    throw assistantProblem("notFound", 404);
  return binding;
}

/** The agent's name for a push notice; a notice without it still goes out. */
export const agentName = (assistants, id) => {
  try {
    return assistants.store.getAssistant(id)?.name;
  } catch {
    return undefined;
  }
};

/**
 * Why a person has no Telegram destination on the agent: pair one first, or, for a
 * user who cannot pair one there (me-telegram.js), that it is not available to her.
 */
export const noTelegram = (agent, userId) =>
  assistantProblem(
    userId === null || canPairTelegram(agent, userId)
      ? "reminderChannelRequired"
      : "reminderTelegramUnavailable",
    409,
  );
