// The agent chat shows the latest history window, read again on every change event
// (several per second while a turn runs), plus the older pages "Earlier messages"
// prepended. A fresh latest window replaces only its own part of the list, so the
// loaded older pages stay (conversations.js pages by offset from the newest message).

/** Prepends an older page; an older page may repeat a newer note, the newer place wins. */
export function withOlderPage(current, page) {
  const shown = new Set(current.messages.map((m) => m.id));
  return {
    ...current,
    nextBefore: page.nextBefore,
    older: true,
    messages: [...page.messages.filter((m) => !shown.has(m.id)), ...current.messages],
  };
}

/**
 * The latest window `next` with the older messages already loaded above it. The
 * window replaces everything from its first message that is shown; an older row it
 * repeats keeps the window's place. Without older pages, with a window that reaches
 * the start of the conversation, or one that no longer touches what is shown (a gap
 * would hide messages), the window alone stands.
 */
export function withLatest(current, next) {
  if (!current?.older || !next.nextBefore) return next;
  const ids = new Set(next.messages.map((m) => m.id));
  const start = current.messages.findIndex((m) => ids.has(m.id));
  if (start < 0) return next;
  const before = current.messages.slice(0, start).filter((m) => !ids.has(m.id));
  if (!before.length) return next;
  return {
    ...next,
    older: true,
    nextBefore: current.nextBefore,
    messages: [...before, ...next.messages],
  };
}
