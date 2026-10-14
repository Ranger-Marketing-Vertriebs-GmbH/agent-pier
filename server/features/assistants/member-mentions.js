// @mentions of a lead's members in an owner message. One parser serves both the
// write proof on the server and the chips in the browser, so what the owner sees
// as a mention is exactly what counts as one. It runs in Node and in the browser.
//
// After "@" the longest display name of a member wins, case-insensitively and only
// when it ends at a word boundary; names may contain spaces ("@Network Architect").
// An "@" inside a word or a path (mail@example.org, /ask@bot, x.com/@scout) starts
// no mention. A name two members share makes the mention ambiguous; an unknown name
// is no mention at all. Text is compared as written, never normalised, so look-alike
// letters and invisible characters mention nobody on either side.
const attached = /[\p{L}\p{N}/.:=_\-\\[>@`~]$/u;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = (name) =>
  new RegExp(`${name.split(/\s+/).map(escape).join("\\s+")}(?![\\p{L}\\p{N}])`, "iuy");

/** The members that can be mentioned: `{ id, name }` with a non-empty name. */
function candidates(members) {
  return (members || [])
    .filter((m) => m && m.id != null && typeof m.name === "string" && m.name.trim())
    .map((m) => ({ id: m.id, match: pattern(m.name.trim()) }));
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
    if (attached.test(text.slice(Math.max(0, at - 2), at))) continue;
    let length = 0,
      ids = [];
    for (const { id, match } of list) {
      match.lastIndex = at + 1;
      const hit = match.exec(text);
      if (!hit || hit[0].length < length) continue;
      if (hit[0].length > length) ids = [];
      length = hit[0].length;
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
// owner's own text, never in code, block quotes, links, images or HTML.
const skipped = new Set([
  "code",
  "inlineCode",
  "html",
  "blockquote",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "footnoteDefinition",
  "footnoteReference",
]);
const blocks = new Set(["paragraph", "heading", "tableCell"]);
/** At most this many mentions of one message are looked at. */
export const mentionLimit = 20;

/**
 * The mentions in a parsed Markdown message (an mdast tree, as remark builds it for
 * the chat and as the server parses the owner's text): `{ parent, node, block,
 * mentions }` per text node, where `block` is the paragraph, heading or table cell
 * around it. The server's proof and the browser's chips both use this, so a mention
 * counts only where the owner sees a chip.
 */
export function treeMentions(tree, members) {
  const found = [];
  let count = 0;
  const walk = (node, block) => {
    for (const child of node.children || []) {
      if (count >= mentionLimit) return;
      if (skipped.has(child.type)) continue;
      if (child.type !== "text") {
        walk(child, blocks.has(child.type) ? child : block);
        continue;
      }
      const mentions = findMentions(child.value, members).slice(0, mentionLimit - count);
      if (!mentions.length) continue;
      count += mentions.length;
      found.push({ parent: node, node: child, block, mentions });
    }
  };
  walk(tree, tree);
  return found;
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
  if (at < 0 || attached.test(before.slice(Math.max(0, at - 2), at))) return null;
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
