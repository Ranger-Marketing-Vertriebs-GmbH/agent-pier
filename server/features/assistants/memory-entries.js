import { memoryFor } from "./runtimes/runtime-for.js";

/**
 * The entries of a memory file of `agent`, the unit the memory review quotes and the
 * archive moves (memory-review-answer.js). Each is `{ text, start, end }`: `text` the
 * entry as written (a list item without its marker), `start`/`end` the offsets of the
 * whole entry in `content`, marker and continuation lines included, line break not.
 *
 * What an entry is, the agent's runtime says (agent-runtime.js `agentFiles.memory`):
 * a Markdown list item with its indented continuation lines or a paragraph line, or
 * one block between separators. An agent that records no runtime, and a missing one,
 * keeps its memory as the default runtime does.
 */
export const memoryEntries = (agent, file, content) => memoryFor(agent).entries(content);

/**
 * `content` without every entry whose text is one of `texts` (memoryEntries), for the
 * archive (memory-archive.js). An entry goes with its own line break or separator;
 * everything else, headings and blank lines included, stays byte for byte. A removed
 * last entry takes the line break or separator before it, so the file ends as it did.
 */
export const withoutEntries = (agent, file, content, texts) =>
  memoryFor(agent).without(content, texts);
