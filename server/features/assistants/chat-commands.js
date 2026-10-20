import { chatProblem } from "./agent-chats.js";

// Commands a person types into an AgentPier chat that AgentPier answers itself
// (AGENTPIER-181). OpenClaw's own `/new` and `/reset` would start a fresh history
// under the chat's key; New chat is a new session instead (agent-chats.js). Telegram
// turns and AgentPier's internal turns are never intercepted.
const people = new Set(["owner", "user"]);
const remembered = 200;

/** The HTTP status of a chat send: a new chat 201, a rename 200, a turn 202. */
export const sendStatus = (result) => (result?.created ? 201 : result?.chat ? 200 : 202);

/**
 * Answers `/new` (a new chat; nothing goes to the Gateway) and `/name <title>` (a
 * rename); refuses `/reset` and `/new` with text. Returns null for every other turn.
 * A repeated `/new` with the same client request id returns the chat it opened.
 */
const commandOf = (input, context) =>
  people.has(context?.kind) && typeof input?.text === "string"
    ? input.text.trim().match(/^\/(new|reset|name)(?:\s+([\s\S]*))?$/i)
    : null;

/** Whether a turn is one of these commands. */
export const isChatCommand = (input, context) => !!commandOf(input, context);

export async function chatCommand(service, conversationId, input, context) {
  const command = commandOf(input, context);
  if (!command) return null;
  const [, name, rest = ""] = command;
  const conversation = service.store.getConversation(conversationId);
  if (name.toLowerCase() === "name")
    return { chat: service.chats.rename(conversationId, rest) };
  if (name.toLowerCase() === "reset" || rest.trim() || input.attachments?.length)
    throw chatProblem("CHAT_COMMAND");
  const opened = (service.openedChats ??= new Map());
  const key = `${conversationId}\n${input.clientRequestId}`;
  if (typeof input.clientRequestId === "string" && opened.has(key))
    return { created: opened.get(key) };
  const created = await service.chats.create(conversation.assistantId, {
    userId: typeof conversation.userId === "string" ? conversation.userId : null,
  });
  if (typeof input.clientRequestId === "string") {
    opened.set(key, created.id);
    if (opened.size > remembered) opened.delete(opened.keys().next().value);
  }
  return { created: created.id };
}
