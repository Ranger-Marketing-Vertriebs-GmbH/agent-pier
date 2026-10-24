import { assistantProblem } from "./assistant-validation.js";
import { handBackNotes } from "./browser-hand-back.js";
import { goalTurn } from "./goal-turns.js";

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
  return cut(plain(text), autoLimit);
}

// Cut before a word that does not fit whole, with "…"; a single long word is cut as
// it is.
function cut(text, limit) {
  const characters = [...text];
  if (!characters.length) return null;
  if (characters.length <= limit) return characters.join("");
  let kept = characters.slice(0, limit - 1);
  if (characters[limit - 1] !== " ") {
    const space = kept.lastIndexOf(" ");
    if (space > 0) kept = kept.slice(0, space);
  }
  return `${kept.join("").trimEnd()}…`;
}

const generatedWords = 12;
// Quotes a model wraps a title in, and what it ends one with.
const quotes = `"'\`«»‹›“”„‟‘’‚‛「」『』`;
const edges = new RegExp(`^[${quotes}\\s]+|[${quotes}\\s.,;:!?…。！？、]+$`, "gu");

const preamble =
  /^\W*(?:sure|okay|ok|certainly|of course|absolutely|here(?:'s|’s| is| are)|hier (?:ist|sind|wäre)|klar|gerne|natürlich|selbstverständlich)\b/iu;
const leadIn = (line) => /[:：]\W*$/u.test(line) || preamble.test(line);

/**
 * A title the agent's model suggested (generated-titles.js), read as untrusted text
 * like a set title: its first line after any lead-in, without reasoning, markdown, a
 * "Title:" label, quotes, trailing punctuation and the characters a set title
 * refuses; null when nothing readable is left or it is longer than a title (80
 * characters, 12 words).
 */
export function generatedTitle(raw) {
  if (typeof raw !== "string") return null;
  const lines = raw
    .replace(/<think>[\s\S]*?(<\/think>|$)/giu, "\n")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"));
  // A lead-in ("Here is a title:", "Sure!") before the title is skipped; a lone one
  // ending in a colon announces a title that never came.
  const index = lines.findIndex((l, i) => !leadIn(l) || i === lines.length - 1);
  const line = lines[index];
  if (!line || /[:：]\W*$/u.test(line)) return null;
  let title = plain(
    line
      // Links keep their text; emphasis, code and heading, quote and list marks go.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/u, "")
      .replace(/(\*{1,3}|_{1,3}|~~|`+)(?=\S)(.*?\S)\1/gu, "$2")
      .replace(/[*`]/gu, ""),
  );
  let previous;
  do {
    previous = title;
    title = title
      .replace(/^(?:title|titel|chat title)\s*[:：]\s*/iu, "")
      .replace(edges, "");
  } while (title !== previous);
  // Asked for 3 to 6 words: a long line is the model talking, not a title.
  if (
    !/[\p{L}\p{N}]/u.test(title) ||
    [...title].length > setLimit ||
    title.split(" ").length > generatedWords
  )
    return null;
  return title;
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
export const written = new Set(["owner", "user", "telegram"]);

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
  const first = firstWrittenTurn(service, conversationId);
  return first ? autoTitle(first.text) : null;
}

/**
 * The chat's first written turn that names it: its request and the text she wrote
 * (without a note AgentPier queued), or null.
 */
export function firstWrittenTurn(service, conversationId) {
  for (const request of service.ledger.requests(conversationId)) {
    const context = service.teams?.store.context(request.id);
    // A continuation is AgentPier's turn, never the person's writing.
    if (goalTurn(context) || !written.has(context?.kind ?? "owner")) continue;
    const text = writtenText(request.text);
    if (autoTitle(text)) return { request, text };
  }
  return null;
}
