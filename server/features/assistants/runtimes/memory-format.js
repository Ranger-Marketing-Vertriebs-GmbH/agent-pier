// How a runtime writes an agent's memory files: the pure part of the agentFiles
// sub-port (agent-runtime.js `agentFiles.memory`). Each adapter states its format
// with defineMemoryFormat; feature code reads it through runtime-for.js memoryFor and
// never parses a memory file itself.

/** The length of a byte order mark at the start of `text`: never part of an entry. */
export const bomLength = (text) => (text.startsWith("﻿") ? 1 : 0);

/**
 * A memory format, frozen. The adapter gives:
 * - `entries(text)`: the entries of a file's text as `{ text, start, end }`;
 * - `separator`: what ends an entry (a line break, or the runtime's own separator);
 * - `lineEnds`: whether a carriage return before a removed last entry goes with it;
 * - `appended(content, text)`: `content` with `text` as its last entry;
 * - `limit(name)`: the characters file `name` may hold, or null without a limit;
 * - `chars(content)`: the characters `content` counts against that limit;
 * - `pinMarker`: what an entry the agent must keep starts with, or null.
 * `without(content, texts)` is the same for every format (below).
 */
export function defineMemoryFormat({
  entries,
  separator,
  lineEnds = false,
  appended,
  limit = () => null,
  chars,
  pinMarker = null,
}) {
  const read = (content) => entries(String(content ?? ""));
  return Object.freeze({
    entries: read,
    without: (content, texts) =>
      withoutEntries(String(content ?? ""), read(content), new Set(texts), {
        separator,
        lineEnds,
      }),
    appended: (content, text) => appended(String(content ?? ""), text),
    limit: (name) => limit(name) ?? null,
    chars: (content) => chars(String(content ?? "")),
    pinMarker,
  });
}

// `text` without every entry whose text is `wanted`. An entry goes with its own
// separator; everything else stays byte for byte. A removed last entry takes the
// separator before it, so the file ends as it did.
function withoutEntries(text, entries, wanted, { separator, lineEnds }) {
  const first = bomLength(text);
  const spans = entries
    .filter((entry) => wanted.has(entry.text))
    .map(({ start, end }) => {
      // From the start of the entry's line or block to past its separator.
      const before = text.lastIndexOf(separator, start - separator.length);
      const from = before < 0 ? first : Math.max(first, before + separator.length);
      const next = text.indexOf(separator, end);
      return [from, next < 0 ? text.length : next + separator.length];
    });
  // Adjacent entries join, so a removed run is one span.
  const merged = [];
  for (const span of spans)
    if (merged.length && span[0] <= merged.at(-1)[1])
      merged.at(-1)[1] = Math.max(merged.at(-1)[1], span[1]);
    else merged.push(span);
  const last = merged.at(-1);
  // The last entry without a separator of its own takes the one before it.
  if (last && last[1] === text.length && !text.endsWith(separator) && last[0] > first) {
    last[0] -= separator.length;
    if (lineEnds && text[last[0] - 1] === "\r") last[0]--;
  }
  let result = text;
  for (const [from, to] of merged.reverse())
    result = result.slice(0, from) + result.slice(to);
  return result;
}
