// The agent list from the `sync` frames of /api/assistant-events
// (server/features/assistants/assistant-list-feed.js): rows keyed by section and id,
// applied with the session chat's applyChatSync. Unchanged sections keep their
// identity, so views that depend on one (the teams, say) do not reload.
import { applyChatSync } from "../chat/chat-sync.js";

const invalid = () => {
  throw new Error("Invalid agent list sync");
};

/** Rebuilds the list from `state` (shape + rows), reusing unchanged sections of `previous`. */
export function listFromRows(state, previous) {
  const sections = new Map();
  for (const row of state.messages) {
    if (!state.shape[row.section]) invalid();
    if (!sections.has(row.section)) sections.set(row.section, []);
    sections.get(row.section).push(row);
  }
  const list = {};
  for (const [section, kind] of Object.entries(state.shape)) {
    const rows = sections.get(section) || [];
    const before = previous?.sections?.get(section) || [];
    if (
      previous?.list &&
      section in previous.list &&
      previous.state?.shape?.[section] === kind &&
      before.length === rows.length &&
      rows.every((row, index) => row === before[index])
    ) {
      list[section] = previous.list[section];
      continue;
    }
    if (kind === "array") list[section] = rows.map((row) => row.value);
    else if (kind === "object")
      list[section] = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    else if (rows.length === 1) list[section] = rows[0].value;
    else invalid();
  }
  return { list, sections };
}

/**
 * Applies a sync frame to `previous` ({state, list, sections} or null). Returns the
 * next value; throws when the frame does not fit the held baseline (another base, a
 * malformed frame), and the caller then asks for the whole list again.
 */
export function applyListSync(previous, data) {
  const state = applyChatSync(previous?.state, data);
  if (
    !Array.isArray(state?.messages) ||
    !state.shape ||
    typeof state.shape !== "object" ||
    !state.sync
  )
    invalid();
  // A whole list keeps the rows that did not change, and with them the sections.
  if (data.sync?.mode !== "delta" && previous?.state) {
    const old = new Map(previous.state.messages.map((row) => [row.id, row]));
    state.messages = state.messages.map((row) => {
      const kept = old.get(row.id);
      return kept && JSON.stringify(kept) === JSON.stringify(row) ? kept : row;
    });
  }
  return { state, ...listFromRows(state, previous) };
}
