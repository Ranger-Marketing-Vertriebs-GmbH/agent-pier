import { hermesEntryDelimiter } from "./runtimes/runtime-for.js";

/**
 * The entries of an agent's memory file, the unit the memory review quotes and the
 * archive moves (memory-review-answer.js). Each is `{ text, start, end }`: `text` the
 * entry as written (a list item without its marker), `start`/`end` the offsets of the
 * whole entry in `content`, marker and continuation lines included, line break not.
 *
 * - OpenClaw (Markdown): one list item with its indented continuation lines, or one
 *   paragraph line; headings and blank lines are no entries.
 * - Hermes: one block between "\n§\n" separators, trimmed, as Hermes parses its
 *   memory (runtimes/hermes/hermes-config/memory.js).
 */
export function memoryEntries(runtime, file, content) {
  const text = String(content ?? "");
  return runtime === "hermes" ? blocks(text) : markdown(text);
}

// A byte order mark is not part of the first entry.
const bom = (text) => (text.startsWith("﻿") ? 1 : 0);

function blocks(content) {
  const entries = [];
  let from = bom(content);
  while (from <= content.length) {
    const next = content.indexOf(hermesEntryDelimiter, from);
    const end = next < 0 ? content.length : next;
    const raw = content.slice(from, end);
    const text = raw.trim();
    if (text) {
      const start = from + raw.indexOf(text);
      entries.push({ text, start, end: start + text.length });
    }
    if (next < 0) break;
    from = next + hermesEntryDelimiter.length;
  }
  return entries;
}

const heading = /^ {0,3}#{1,6}(?:\s|$)/;
const listItem = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;

function markdown(content) {
  const entries = [];
  // The list item continuation lines may still join.
  let item = null;
  let offset = bom(content);
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
      entries.push(item);
    } else if (item && /^\s/.test(line)) item.end = lineEnd;
    else {
      item = null;
      const start = lineStart + (line.length - line.trimStart().length);
      entries.push({ body: start, start, end: lineEnd });
    }
  }
  return entries.map(({ body, start, end }) => ({
    text: content.slice(body, end),
    start,
    end,
  }));
}

/**
 * `content` without every entry whose text is one of `texts` (memoryEntries), for the
 * archive (memory-archive.js). An entry goes with its own line break, a Hermes block
 * with one separator; everything else, headings and blank lines included, stays
 * byte for byte. A removed last entry takes the line break or separator before it,
 * so the file ends as it did.
 */
export function withoutEntries(runtime, file, content, texts) {
  const text = String(content ?? "");
  const wanted = new Set(texts);
  const hermes = runtime === "hermes";
  const separator = hermes ? hermesEntryDelimiter : "\n";
  const first = bom(text);
  const spans = memoryEntries(runtime, file, text)
    .filter((entry) => wanted.has(entry.text))
    .map(({ start, end }) => {
      // From the start of the entry's line (Hermes: its block) to past its separator.
      const before = text.lastIndexOf(separator, start - (hermes ? separator.length : 1));
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
    if (!hermes && text[last[0] - 1] === "\r") last[0]--;
  }
  let result = text;
  for (const [from, to] of merged.reverse())
    result = result.slice(0, from) + result.slice(to);
  return result;
}
