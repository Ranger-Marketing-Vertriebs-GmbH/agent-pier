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
