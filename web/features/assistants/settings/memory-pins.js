// A Hermes agent's memory file as the memory page pins it. This mirrors
// server/features/assistants/runtimes/hermes/hermes-config/memory.js (and
// tests/unit/memory-pins.test.js keeps them alike): entries are separated by "\n§\n",
// Hermes counts them stripped, without empty ones, joined by that separator, in code
// points; an entry that starts with the marker is pinned and the nightly dream keeps
// it word for word.

const entryDelimiter = "\n§\n";

/** The marker a pinned entry starts with; it counts toward the limit. */
export const pinMarker = "📌 ";

/** The entries of a memory file's text, as Hermes parses them. */
export const entriesOf = (text) =>
  String(text ?? "")
    .replace(/^﻿/, "")
    .split(entryDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

const count = (entries) => [...entries.join(entryDelimiter)].length;

/** The characters Hermes counts for the text against its limit. */
export const charsOf = (text) => count(entriesOf(text));

/** The characters the pinned entries take, counted the same way. */
export const pinnedCharsOf = (text) =>
  count(entriesOf(text).filter((entry) => entry.startsWith(pinMarker)));

const markers = new RegExp(`^(?:${pinMarker}\\s*)+`, "u");

/**
 * The text with the `index`-th entry (as entriesOf numbers them) pinned or unpinned,
 * every other part of the text keeping its bytes. Pinning puts the marker after the
 * entry's leading blanks; unpinning takes out every marker it starts with and the
 * blanks after them, so the entry is unpinned afterwards. An index past the entries
 * changes nothing. (An entry whose text starts with a "§" line after a blank line
 * would, unpinned, read as a separator; Hermes's memory tool writes no such entry.)
 */
export function togglePin(text, index) {
  const parts = String(text ?? "").split(entryDelimiter);
  let seen = -1;
  const at = parts.findIndex((part) => part.trim() && ++seen === index);
  if (at < 0) return String(text ?? "");
  const part = parts[at];
  const lead = part.match(/^\s*/)[0];
  const rest = part.slice(lead.length);
  const core = rest.trimEnd();
  parts[at] = core.startsWith(pinMarker)
    ? lead + core.replace(markers, "") + rest.slice(core.length)
    : lead + pinMarker + rest;
  return parts.join(entryDelimiter);
}
