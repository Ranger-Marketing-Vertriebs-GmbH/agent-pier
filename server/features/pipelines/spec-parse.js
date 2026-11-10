// Reads a spec's markdown: its acceptance criteria and its assumptions. A spec is
// written by an agent: its lines are read by the scanners of line-scan.js, in time
// linear in their length.
import { headingText, listItemText, withoutTail } from "./line-scan.js";

const ITEMS = 50;
const ITEM_TEXT = 2000;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const indentOf = (line) => /^[ \t]*/.exec(line)[0].replace(/\t/g, "    ").length;

// Sections by their heading, outside fenced code; the first section of a name counts.
function sections(text) {
  const found = new Map();
  let current = null,
    fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : headingText(line);
    if (heading !== null) {
      const name = heading
        .toLowerCase()
        .replace(/[^a-z]+/g, " ")
        .trim();
      current = found.has(name) ? null : name;
      if (current) found.set(current, []);
    } else if (current) found.get(current).push(line);
  }
  return found;
}

// The first section whose name starts with `prefix`, e.g. "Acceptance criteria (AC)".
function section(parts, prefix) {
  for (const [name, lines] of parts)
    if (name === prefix || name.startsWith(`${prefix} `)) return lines;
  return [];
}

// Top-level list items. The first item sets the list's indent: an item indented
// further is a nested item and, like any indented line, continues the item before it.
// A line straight after an item continues it too; after a blank line, an unindented
// line that is no item ends the list, so closing prose never joins the last item.
// `itemText` returns the text of a line that is an item, and null for any other line.
function listItems(lines, itemText) {
  const items = [];
  let base = null,
    open = false,
    blank = false;
  for (const line of lines) {
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const indent = indentOf(line);
    const item = itemText(line);
    if (item !== null && (base === null || indent <= base)) {
      base ??= indent;
      items.push(item.trim());
      open = true;
    } else if (open && (!blank || indent > base))
      items[items.length - 1] += `\n${line.trim()}`;
    else open = false;
    blank = false;
  }
  return items.filter(Boolean).slice(0, ITEMS);
}

const productDecision =
  /\[\s*product[\s_-]+decision\s*\]|\(\s*product[\s_-]+decision\s*\)|^product[\s_-]+decision\s*:/i;

// Acceptance criteria are the numbered items under "Acceptance criteria", AC1 for the
// first; "Verify: …" in an item says how to check it. Assumptions marked
// "[product decision]" need the owner's confirmation.
export function parseSpec(text) {
  const parts = sections(text);
  const criteria = listItems(section(parts, "acceptance criteria"), (line) =>
    listItemText(line),
  ).map((item, index) => {
    const verify = /\b(?:how to verify|verify|verification)\s*:\s*([\s\S]+)$/i.exec(item);
    const head = verify ? withoutTail(item.slice(0, verify.index), "(—–-") : item;
    return {
      id: `AC${index + 1}`,
      text: clip(head || item, ITEM_TEXT),
      ...(verify ? { verify: clip(verify[1].trim(), ITEM_TEXT) } : {}),
    };
  });
  const assumptions = listItems(section(parts, "assumptions"), (line) =>
    listItemText(line, true),
  ).map((item, index) => {
    const flagged = productDecision.test(item);
    const plain = item.replace(productDecision, "").trim();
    return {
      id: `A${index + 1}`,
      text: clip(plain || item, ITEM_TEXT),
      productDecision: flagged,
    };
  });
  return { criteria, assumptions };
}
