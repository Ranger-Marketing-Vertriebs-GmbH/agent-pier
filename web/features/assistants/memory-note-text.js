import { memoryNoteCopy } from "../../lib/i18n/messages/assistant-memory-notes.js";

/** A note's text; a reason that names models needs the note's details. */
export function memoryNoteText(note) {
  const text = memoryNoteCopy.reasons[note.reason];
  if (typeof text !== "function") return text || memoryNoteCopy.unknown;
  const { from, to } = note.details || {};
  return from && to ? text(from, to) : memoryNoteCopy.unknown;
}
