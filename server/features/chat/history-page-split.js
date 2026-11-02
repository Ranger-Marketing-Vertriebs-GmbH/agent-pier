import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

// Paging over a fully read history, shared by history-page.js and the CLI histories.
const PAGE_MESSAGES = 50;
export function splitPage(messages, continuation) {
  const start = Math.max(0, messages.length - PAGE_MESSAGES);
  return {
    messages: messages.slice(start),
    next: start ? { remaining: messages.slice(0, start), continuation } : continuation,
  };
}

export function legacyPage(content, state) {
  const end = state?.before
    ? content.messages.findIndex((message) => message.id === state.before)
    : content.messages.length;
  if (end < 0) throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
  const start = Math.max(0, end - PAGE_MESSAGES);
  return {
    ...content,
    messages: content.messages.slice(start, end),
    next: start ? { before: content.messages[start].id, legacy: true } : null,
  };
}
