import { assistantProblem } from "./assistant-validation.js";
import { handBackNotes } from "./browser-hand-back.js";

// A chat's title (AGENTPIER-181): the first message's start, or one the person set.
// Without either the chat list shows "New chat", or "Main chat" for the main chat.
const autoLimit = 60;
const setLimit = 80;

// Control and format characters (bidi overrides, zero-width spaces) and line or
// paragraph separators never reach a title; the zero-width joiners that build emoji
// and some scripts' words stay.
const hidden = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const hiddenRuns = new RegExp(`(?:${hidden.source})+`, "gu");

const plain = (text) => text.replace(hiddenRuns, " ").replace(/\s+/g, " ").trim();

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
 * A title the person sets: 1 to 80 characters without the control or format
 * characters an automatic title drops, trimmed; "" asks for the automatic title again.
 */
export function setTitle(value) {
  if (typeof value !== "string" || hidden.test(value)) throw assistantProblem("invalid");
  const title = value.trim();
  if ([...title].length > setLimit) throw assistantProblem("invalid");
  return title;
}

// The kinds of turn whose text a person wrote in the chat.
const written = new Set(["owner", "user", "telegram"]);

/**
 * Names a chat after its first written turn, once a written turn was accepted: a set
 * title, or an automatic one already there, is never overwritten. A chat from before
 * titles existed is named after its first message, not the turn just written. The chat
 * is read again: a rename made while the turn was being admitted wins.
 */
export function titleFromTurn(service, conversation, context) {
  if (!written.has(context?.kind)) return;
  const current = service.store.storedConversation(conversation.id);
  if (current.titleSource || current.deletedAt) return;
  const title = firstTurnTitle(service, conversation.id);
  if (title)
    service.store.updateConversation(conversation.id, { title, titleSource: "auto" });
}

// A note AgentPier queued into the chat (browser-hand-back.js) goes out as the
// person's turn but is not her writing: only what she appended to it may name the chat.
function writtenText(text) {
  let rest = typeof text === "string" ? text.trimStart() : "";
  for (const note of Object.values(handBackNotes))
    if (rest.startsWith(note)) rest = rest.slice(note.length);
  return rest;
}

/** The automatic title from the chat's first written turn, or null. */
export function firstTurnTitle(service, conversationId) {
  for (const request of service.ledger.requests(conversationId)) {
    const kind = service.teams?.store.context(request.id)?.kind ?? "owner";
    if (!written.has(kind)) continue;
    const title = autoTitle(writtenText(request.text));
    if (title) return title;
  }
  return null;
}
