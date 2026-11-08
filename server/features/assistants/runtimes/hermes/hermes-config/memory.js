// A Hermes agent's built-in memory (website/docs/user-guide/features/memory.md):
// two files in `<HERMES_HOME>/memories/` (tools/memory_tool.py get_memory_dir),
// MEMORY.md for the agent's notes and USER.md for its profile of the user. Entries
// are separated by "\n§\n"; Hermes counts a store as its entries, stripped and
// without empty ones, joined by that separator (tools/memory_tool_store.py
// `_parse_entries`, `_char_count`). Verified against Hermes v0.22.5.

export const memoryFolder = "memories";
export const entryDelimiter = "\n§\n";

/**
 * The hard limits in characters AgentPier gives every Hermes agent, four times
 * Hermes's defaults (hermes_cli/config_defaults.py `memory_char_limit`,
 * `user_char_limit`). AgentPier compiles them into config.yaml, so the limit it checks
 * an owner's edit against is the one Hermes enforces.
 */
export const memoryLimits = Object.freeze({ "MEMORY.md": 10000, "USER.md": 5000 });

/**
 * AgentPier's convention, not Hermes's: an entry that starts with this marker is
 * pinned, and the nightly dream must keep it word for word. It counts toward the limit.
 */
export const pinMarker = "📌 ";

/** The entries of a memory file's text, as Hermes parses them. */
export const memoryEntries = (text) =>
  String(text ?? "")
    .replace(/^﻿/, "")
    .split(entryDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * The characters Hermes counts for a memory file's text against its limit: Python's
 * `len`, code points rather than UTF-16 units.
 */
export const memoryChars = (text) => [...memoryEntries(text).join(entryDelimiter)].length;

/** Whether a memory entry (already trimmed, see memoryEntries) is pinned. */
export const pinned = (entry) => String(entry ?? "").startsWith(pinMarker);

/** The pinned entries of a memory file's text, in order. */
export const pinnedEntries = (text) => memoryEntries(text).filter(pinned);

/** The characters the pinned entries of a memory file take, as Hermes counts them. */
export const pinnedChars = (text) => [...pinnedEntries(text).join(entryDelimiter)].length;
