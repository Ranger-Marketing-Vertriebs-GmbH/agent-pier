/** The longest text a chat delivery takes (chat-delivery.js on the server). */
const MAX_TEXT = 32000;

/**
 * Ids of the stop notes an earlier message already carries: the draft's outbox and
 * recent deliveries that were not rejected. A rejected delivery keeps its notes
 * pending on the server, so the next message carries them again.
 */
export function carriedStopNoteIds({ outbox, recent = [] } = {}) {
  const ids = new Set();
  for (const item of [...recent, outbox])
    if (item && item.status !== "rejected")
      for (const id of item.stopNoteIds || []) ids.add(id);
  return ids;
}

/**
 * The text a message submits with the pending stop notes of its session
 * (`observability.stopNotes`), and the ids it names so the server forgets them once
 * the delivery is accepted. Slash commands and `!` shell lines never carry a note,
 * nor does a message that would grow past the delivery limit. A line the text holds
 * already (a message put back into the composer) is named, not repeated.
 */
export function appendStopNotes(text, notes, carried = new Set()) {
  const unchanged = { text, stopNoteIds: [] };
  if (/^[/!]/.test(text.trim())) return unchanged;
  const pending = (Array.isArray(notes) ? notes : []).filter(
    (note) =>
      typeof note?.id === "string" &&
      typeof note.text === "string" &&
      !carried.has(note.id),
  );
  if (!pending.length) return unchanged;
  const lines = pending.filter((note) => !text.includes(note.text)).map((n) => n.text);
  const next = lines.length ? `${text}\n\n${lines.join("\n")}` : text;
  if (next.length > MAX_TEXT) return unchanged;
  return { text: next, stopNoteIds: pending.map((note) => note.id) };
}

/** The draft's text with the pending notes its earlier messages do not carry yet. */
export const withStopNotes = (draft, notes) =>
  appendStopNotes(draft.text, notes, carriedStopNoteIds(draft));
