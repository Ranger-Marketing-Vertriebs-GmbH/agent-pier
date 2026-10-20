import { assistantProblem } from "./assistant-validation.js";

// A chat's title (AGENTPIER-181): the first message's start, or one the person set.
// Without either the chat list shows "New chat", or "Main chat" for the main chat.
const autoLimit = 60;
const setLimit = 80;

const plain = (text) =>
  text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The automatic title of a chat from its first message: whitespace collapsed, cut at
 * a word to at most 60 characters with "…"; null for an empty or attachment-only one.
 */
export function autoTitle(text) {
  if (typeof text !== "string") return null;
  const characters = [...plain(text)];
  if (!characters.length) return null;
  if (characters.length <= autoLimit) return characters.join("");
  let kept = characters.slice(0, autoLimit - 1);
  // Cut before a word that does not fit whole; a single long word is cut as it is.
  if (characters[autoLimit - 1] !== " ") {
    const space = kept.lastIndexOf(" ");
    if (space > 0) kept = kept.slice(0, space);
  }
  return `${kept.join("").trimEnd()}…`;
}

/**
 * A title the person sets: 1 to 80 characters without control characters, trimmed;
 * "" asks for the automatic title again.
 */
export function setTitle(value) {
  if (typeof value !== "string" || /\p{Cc}/u.test(value))
    throw assistantProblem("invalid");
  const title = value.trim();
  if ([...title].length > setLimit) throw assistantProblem("invalid");
  return title;
}

// The kinds of turn whose text a person wrote in the chat.
const written = new Set(["owner", "user", "telegram"]);

/**
 * Names a chat after its first written turn, once: a set title, or an automatic one
 * already there, is never overwritten.
 */
export function titleFromTurn(store, conversation, text, context) {
  if (conversation.titleSource || !written.has(context?.kind)) return;
  const title = autoTitle(text);
  if (title) store.updateConversation(conversation.id, { title, titleSource: "auto" });
}

/** The automatic title from the chat's first written turn, or null. */
export function firstTurnTitle(service, conversationId) {
  for (const request of service.ledger.requests(conversationId)) {
    const kind = service.teams?.store.context(request.id)?.kind ?? "owner";
    if (!written.has(kind)) continue;
    const title = autoTitle(request.text);
    if (title) return title;
  }
  return null;
}
