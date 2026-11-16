import { bomLength, defineMemoryFormat } from "../memory-format.js";

// OpenClaw's memory files are Markdown the agent writes with its file tools
// (MEMORY.md, USER.md and notes under memory/). An entry is one list item with its
// indented continuation lines, or one paragraph line; headings and blank lines are
// no entries. OpenClaw sets no limit and AgentPier knows no pinned entry there.

const heading = /^ {0,3}#{1,6}(?:\s|$)/;
const listItem = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;

// `{ text, start, end }` per entry: `text` without the list marker, `start`/`end`
// the whole entry in `content`, marker and continuation lines included, line break
// not.
function entries(content) {
  const found = [];
  // The list item continuation lines may still join.
  let item = null;
  let offset = bomLength(content);
  for (const raw of content.slice(offset).split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || heading.test(line)) {
      item = null;
      continue;
    }
    const lineEnd = lineStart + line.length;
    const marker = line.match(listItem);
    if (marker) {
      item = { body: lineStart + marker[0].length, start: lineStart, end: lineEnd };
      found.push(item);
    } else if (item && /^\s/.test(line)) item.end = lineEnd;
    else {
      item = null;
      const start = lineStart + (line.length - line.trimStart().length);
      found.push({ body: start, start, end: lineEnd });
    }
  }
  return found.map(({ body, start, end }) => ({
    text: content.slice(body, end),
    start,
    end,
  }));
}

/** The memory format of OpenClaw's agents (agent-runtime.js `agentFiles.memory`). */
export const openClawMemory = defineMemoryFormat({
  entries,
  separator: "\n",
  lineEnds: true,
  // A new entry is a list item at the end of the file.
  appended(content, text) {
    if (!content) return `- ${text}\n`;
    return content.endsWith("\n") ? `${content}- ${text}\n` : `${content}\n- ${text}`;
  },
  chars: (content) => [...content].length,
});
