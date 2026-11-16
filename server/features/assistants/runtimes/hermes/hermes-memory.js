import { bomLength, defineMemoryFormat } from "../memory-format.js";
import {
  entryDelimiter,
  memoryChars,
  memoryLimits,
  pinMarker,
} from "./hermes-config/memory.js";

// A Hermes agent's memory files (hermes-config/memory.js): blocks between "\n§\n"
// separators, each trimmed, as Hermes parses them; MEMORY.md and USER.md each hold a
// limited number of characters, which Hermes counts over the joined entries.

// `{ text, start, end }` per block that holds text, `start`/`end` around its text.
function entries(content) {
  const found = [];
  let from = bomLength(content);
  while (from <= content.length) {
    const next = content.indexOf(entryDelimiter, from);
    const end = next < 0 ? content.length : next;
    const raw = content.slice(from, end);
    const text = raw.trim();
    if (text) {
      const start = from + raw.indexOf(text);
      found.push({ text, start, end: start + text.length });
    }
    if (next < 0) break;
    from = next + entryDelimiter.length;
  }
  return found;
}

/** The memory format of Hermes agents (agent-runtime.js `agentFiles.memory`). */
export const hermesMemory = defineMemoryFormat({
  entries,
  separator: entryDelimiter,
  // A new entry is a block after the last one.
  appended: (content, text) =>
    entries(content).length ? `${content}${entryDelimiter}${text}` : text,
  limit: (name) => (Object.hasOwn(memoryLimits, name) ? memoryLimits[name] : null),
  chars: memoryChars,
  pinMarker,
});
