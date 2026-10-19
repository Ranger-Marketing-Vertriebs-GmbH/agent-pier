// The agent chat's rows: the live window the feed keeps current
// (useAgentConversationStream), the rows it pushed out while the chat was open, and
// the older pages "Earlier messages" prepended. Pages count by offset from the newest
// message (conversations.js), so a page read after the window advanced overlaps what
// is shown; it never leaves a gap, and the newer place of a row wins.
import { chatWindowPrefix, prependHistoryRows } from "../chat/chat-sync.js";

export const emptyHistoryView = {
  live: null,
  prefix: [],
  older: [],
  olderBefore: null,
  olderLoaded: false,
};

// chatWindowPrefix reads the session chat's paging cursor.
const paged = (history) => ({
  messages: history.messages,
  history: { cursor: history.nextBefore },
});

/** A new live window: rows it pushed out stay above it with the older pages. */
export function withLive(view, live) {
  const previous = view.live;
  // A window that reaches the start of the conversation shows all of it.
  if (!previous || !live.nextBefore) return { ...emptyHistoryView, live };
  const ids = new Set(live.messages.map((m) => m.id));
  // Disjoint windows (a burst larger than the window) cannot be joined without a
  // gap: the newest window starts again.
  if (
    previous.messages.length &&
    live.messages.length &&
    !previous.messages.some((m) => ids.has(m.id))
  )
    return { ...emptyHistoryView, live };
  const seen = new Set();
  const prefix = [
    ...view.prefix,
    ...chatWindowPrefix(paged(previous), paged(live)),
  ].filter((m) => !ids.has(m.id) && !seen.has(m.id) && seen.add(m.id));
  return { ...view, live, prefix };
}

/** An older page read with the shown `nextBefore`, prepended above everything. */
export function withOlder(view, page) {
  const known = new Set(
    [...view.prefix, ...(view.live?.messages || [])].map((m) => m.id),
  );
  return {
    ...view,
    older: prependHistoryRows(view.older, page.messages || [], known),
    olderBefore: page.nextBefore ?? null,
    olderLoaded: true,
  };
}

/** The history the chat renders: live metadata, every row once, the newer place first. */
export function shownHistory(view) {
  const live = view.live || { messages: [], requests: [], stale: false };
  const ids = new Set(live.messages.map((m) => m.id));
  const prefix = view.prefix.filter((m) => !ids.has(m.id));
  for (const m of prefix) ids.add(m.id);
  const older = view.older.filter((m) => !ids.has(m.id));
  return {
    ...live,
    messages: [...older, ...prefix, ...live.messages],
    nextBefore: view.olderLoaded ? view.olderBefore : (live.nextBefore ?? null),
  };
}
