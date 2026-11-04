import { appendedDraftText } from "./chat-draft-reuse.js";

/** Characters a chat message may hold (server/features/sessions/session-chat-input.js). */
export const MAX_CHAT_TEXT = 32000;

// The mounted chat drafts by delivery scope. Two panes of one session each mount a
// ChatDraft over the same stored draft, so a scope holds a set.
const composers = new Map();

/** Registers a mounted composer's draft; the returned function removes only it. */
export function registerComposer(scope, draft) {
  if (!composers.has(scope)) composers.set(scope, new Set());
  composers.get(scope).add(draft);
  return () => {
    const drafts = composers.get(scope);
    if (!drafts?.delete(draft)) return;
    if (drafts.size === 0) composers.delete(scope);
  };
}

/**
 * Appends `text` to the scope's composer by the append rule of chat-draft-reuse.js.
 * Never truncates: a draft plus text over MAX_CHAT_TEXT is "too-long". A draft with a
 * pending outbox, an unreadable one, or an edit that did not land is "locked".
 * @returns {Promise<"appended" | "locked" | "missing" | "too-long">}
 */
export async function appendToComposer(scope, text) {
  const drafts = [...(composers.get(scope) ?? [])];
  const draft = drafts[0];
  if (!draft) return "missing";
  const current = draft.getSnapshot();
  if (current.outbox || draft.corrupt) return "locked";
  const next = appendedDraftText(current.text, text);
  if (next.length > MAX_CHAT_TEXT) return "too-long";
  await draft.change({ text: next });
  if (draft.getSnapshot().text !== next) return "locked";
  // The other panes' drafts read the stored draft again; a same-window write fires
  // no storage event.
  for (const other of drafts.slice(1)) other.reload();
  return "appended";
}
