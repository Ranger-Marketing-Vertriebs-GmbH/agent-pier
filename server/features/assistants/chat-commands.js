import { chatProblem } from "./agent-chats.js";

// Commands a person types into an AgentPier chat that AgentPier answers itself
// (AGENTPIER-181). OpenClaw's own `/new` and `/reset` would start a fresh history
// under the chat's key; New chat is a new session instead (agent-chats.js). Telegram
// turns and AgentPier's internal turns are never intercepted.
const people = new Set(["owner", "user"]);

/** The HTTP status of a chat send: a new chat 201, a rename 200, a turn 202. */
export const sendStatus = (result) => (result?.created ? 201 : result?.chat ? 200 : 202);

/**
 * Answers `/new` (a new chat; nothing goes to the Gateway) and `/name <title>` (a
 * rename); refuses `/reset` and `/new` with text. Returns null for every other turn.
 * A repeated `/new` with the same client request id returns the chat it opened, also
 * while the first is still opening it and after a restart (AgentChats.create).
 */
const commandOf = (input, context) =>
  people.has(context?.kind) && typeof input?.text === "string"
    ? input.text.trim().match(/^\/(new|reset|name)(?:\s+([\s\S]*))?$/i)
    : null;

/** Whether a turn is one of these commands. */
export const isChatCommand = (input, context) => !!commandOf(input, context);

// `/reset`, and `/new` with text or attachments, are refused whenever they are sent.
const refused = ([, name, rest = ""], input) =>
  name.toLowerCase() === "reset" ||
  (name.toLowerCase() === "new" && (!!rest.trim() || !!input.attachments?.length));

/**
 * Why a queued message that is one of these commands is refused: `CHAT_COMMAND` for
 * one that is never run, `CHAT_COMMAND_QUEUED` for `/new` and `/name`, which act at
 * once and must be sent when the agent is done. Null for every other message.
 */
export function queuedCommandRefusal(input) {
  const command = commandOf(input, { kind: "owner" });
  if (!command) return null;
  return refused(command, input) ? "CHAT_COMMAND" : "CHAT_COMMAND_QUEUED";
}

export async function chatCommand(service, conversationId, input, context) {
  const command = commandOf(input, context);
  if (!command) return null;
  const [, name, rest = ""] = command;
  const conversation = service.store.getConversation(conversationId);
  if (name.toLowerCase() === "name")
    return { chat: service.chats.rename(conversationId, rest) };
  if (refused(command, input)) throw chatProblem("CHAT_COMMAND");
  const created = await service.chats.create(conversation.assistantId, {
    userId: typeof conversation.userId === "string" ? conversation.userId : null,
    openedBy:
      typeof input.clientRequestId === "string"
        ? `${conversationId}\n${input.clientRequestId}`
        : null,
  });
  return { created: created.id };
}
