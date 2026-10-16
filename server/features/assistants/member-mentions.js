// @mentions of a lead's members in an owner message. One parser serves both the
// write proof on the server and the chips in the browser, so what the owner sees
// as a mention is exactly what counts as one. It runs in Node and in the browser.
//
// After "@" the longest display name of a member wins, case-insensitively and only
// when it ends at a word boundary; names may contain spaces ("@Network Architect").
// An "@" right after a letter, a digit or a path or markup character
// (mail@example.org, /ask@bot, x.com/@scout, \@Scout) starts no mention. A name two
// members share makes the mention ambiguous; an unknown name is no mention at all.
//
// Text is never normalised. Case is compared by a simple per-character fold that
// only maps a character to a lower case that maps back to the same upper case, so
// look-alikes such as "ſ" for "s" or the Kelvin sign for "K", other scripts' letters
// and invisible characters inside a name mention nobody, on either side.
const attached = /^[\p{L}\p{N}/.:=_\-\\[>@`~]$/u;
const space = /^\s$/u;
const wordChar = /^[\p{L}\p{N}]$/u;
/** The character just before index `at` (a whole code point). */
const charBefore = (text, at) =>
  Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) || "";
const fold = (ch) => {
  const lower = ch.toLowerCase();
  return Array.from(lower).length === 1 && lower.toUpperCase() === ch.toUpperCase()
    ? lower
    : ch;
};

/** The members that can be mentioned: `{ id, name }` with a non-empty name. */
function candidates(members) {
  return (members || [])
    .filter((m) => m && m.id != null && typeof m.name === "string" && m.name.trim())
    .map((m) => ({
      id: m.id,
      parts: m.name
        .trim()
        .split(/\s+/)
        .map((part) => Array.from(part).map(fold)),
    }));
}

/** The length of the name `parts` written at `text[at]`, or 0. */
function matchAt(text, at, parts) {
  let i = at;
  for (let p = 0; p < parts.length; p++) {
    if (p > 0) {
      const gap = i;
      while (i < text.length && space.test(text[i])) i++;
      if (i === gap) return 0;
    }
    for (const want of parts[p]) {
      const point = text.codePointAt(i);
      if (point === undefined) return 0;
      const ch = String.fromCodePoint(point);
      if (fold(ch) !== want) return 0;
      i += ch.length;
    }
  }
  const next = text.codePointAt(i);
  return next !== undefined && wordChar.test(String.fromCodePoint(next)) ? 0 : i - at;
}

/**
 * Every mention in `text` of one of `members` (`{ id, name }`), in order:
 * `{ start, end, memberId, memberIds, ambiguous }`. `start` is the index of "@",
 * `end` the index after the name; `memberId` is null when the mention is ambiguous,
 * and `memberIds` lists every member it could mean.
 */
export function findMentions(text, members) {
  const list = candidates(members),
    found = [];
  if (typeof text !== "string" || !list.length) return found;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (attached.test(charBefore(text, at))) continue;
    let length = 0,
      ids = [];
    for (const { id, parts } of list) {
      const hit = matchAt(text, at + 1, parts);
      if (!hit || hit < length) continue;
      if (hit > length) ids = [];
      length = hit;
      if (!ids.includes(id)) ids.push(id);
    }
    if (!length) continue;
    found.push({
      start: at,
      end: at + 1 + length,
      memberId: ids.length === 1 ? ids[0] : null,
      memberIds: ids,
      ambiguous: ids.length > 1,
    });
    at += length;
  }
  return found;
}

// Where a mention may stand in a Markdown message, as the chat renders it: in the
// owner's own text, never in code, block quotes, struck-through text, links, images,
// footnotes or HTML. The lead's quote of the owner counts only outside them, too.
export const skipped = new Set([
  "code",
  "inlineCode",
  "html",
  "blockquote",
  "delete",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "footnoteDefinition",
  "footnoteReference",
]);
const blocks = new Set(["paragraph", "heading", "tableCell"]);
/** Bounds on a message whose mentions are looked at; beyond them it has none. */
export const mentionLimits = {
  mentions: 20,
  characters: 20000,
  depth: 24,
  // Emphasis marks, which Markdown pairs up in quadratic time.
  marks: 1000,
};
/** At most this many mentions of one message are looked at. */
export const mentionLimit = mentionLimits.mentions;
// A line that opens many containers at once ("- - - > 1. …").
const nested = new RegExp(
  `^(?:[ \\t]*(?:>[ \\t]*|(?:[*+-]|\\d{1,9}[.)])[ \\t]+)){${mentionLimits.depth}}`,
  "m",
);

/**
 * Whether a message is small and flat enough to look for mentions in. The server
 * parses only such messages, and the browser shows chips only on them.
 */
export const mentionableSource = (source) =>
  typeof source === "string" &&
  source.length <= mentionLimits.characters &&
  (source.match(/[*_~]/g) || []).length <= mentionLimits.marks &&
  !nested.test(source);

const count = (text, ch) => text.split(ch).length - 1;

/**
 * The mentions in a parsed Markdown message (an mdast tree with positions, as
 * remark builds it for the chat and as the server parses the owner's text) and its
 * `source`: `{ parent, node, block, mentions }` per text node, where `block` is the
 * paragraph, heading or table cell around it and each mention carries its
 * `offset` in the source. The server's proof and the browser's chips both use this,
 * so a mention counts only where the owner sees a chip.
 *
 * A mention counts only as written in the source: not from a character reference
 * ("&#64;Scout") or an escape ("\@Scout"), not right after a letter or path
 * character in the source ("x*@Scout*"), and not in a tree nested deeper than
 * `mentionLimits.depth`, which then has no mentions at all.
 */
export function treeMentions(tree, members, source) {
  if (!mentionableSource(source)) return [];
  const found = [];
  let total = 0,
    deep = false;
  const walk = (node, block, depth) => {
    if (depth > mentionLimits.depth) {
      deep = true;
      return;
    }
    for (const child of node.children || []) {
      if (deep || total >= mentionLimit) return;
      if (skipped.has(child.type)) continue;
      if (child.type !== "text") {
        walk(child, blocks.has(child.type) ? child : block, depth + 1);
        continue;
      }
      const mentions = located(child, findMentions(child.value, members), source).slice(
        0,
        mentionLimit - total,
      );
      if (!mentions.length) continue;
      total += mentions.length;
      found.push({ parent: node, node: child, block, mentions });
    }
  };
  walk(tree, tree, 0);
  return deep ? [] : found;
}

// The mentions of a text node that stand in the source as written. The k-th "@" of
// the node's text is the k-th "@" of its source only when no "@" came from a
// character reference; otherwise none of the node's mentions count.
function located(node, mentions, source) {
  if (!mentions.length) return mentions;
  const start = node.position?.start?.offset,
    end = node.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  const written = source.slice(start, end);
  if (count(written, "@") !== count(node.value, "@")) return [];
  const ats = [];
  for (let i = written.indexOf("@"); i >= 0; i = written.indexOf("@", i + 1)) ats.push(i);
  return mentions.flatMap((m) => {
    const said = node.value.slice(m.start, m.end);
    const at = ats[count(node.value.slice(0, m.start), "@")];
    if (at === undefined || written.slice(at, at + said.length) !== said) return [];
    // Emphasis marks hide nothing: "x*@Scout*" is still attached to "x".
    const before = source.slice(Math.max(0, start + at - 64), start + at);
    const bare = before.replace(/[*_~]+$/u, "");
    if (attached.test(charBefore(bare, bare.length))) return [];
    return [{ ...m, offset: start + at }];
  });
}

/** All text of a node, with a space between its parts. */
export const nodeText = (node) =>
  typeof node.value === "string"
    ? node.value
    : (node.children || []).map(nodeText).join(" ");

/**
 * The "@query" being typed just before `caret`, for the composer's autocomplete:
 * `{ start, query }` or null. The query may contain single spaces, so names with
 * spaces can be typed in full; a line break or a second "@" ends it.
 */
export function mentionQuery(text, caret) {
  const before = String(text).slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || attached.test(charBefore(before, at))) return null;
  const query = before.slice(at + 1);
  if (query.length > 60 || /\n|\s{2}|^\s/.test(query)) return null;
  return { start: at, query };
}

/** The members whose name matches what was typed after "@", best first. */
export function mentionMatches(query, members) {
  const typed = query.trim().toLocaleLowerCase();
  const ranked = [];
  for (const m of members || []) {
    const name = String(m?.name || "").toLocaleLowerCase();
    if (!name) continue;
    const at = name.indexOf(typed);
    if (at < 0) continue;
    // Name starts first, then word starts, then anywhere.
    const rank = at === 0 ? 0 : /\s/.test(name[at - 1]) ? 1 : 2;
    ranked.push({ m, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.m.name.localeCompare(b.m.name))
    .map((r) => r.m);
}
