// Content anchors for review comments on parsed diff rows. Shared by the server
// and the browser bundle: no Buffer, no node: imports.

/**
 * @typedef {{ kind: "add" | "remove" | "context", text: string }} ExcerptRow
 * @typedef {{
 *   side: "old" | "new",
 *   line: number,
 *   text: string,
 *   before: string[],
 *   after: string[],
 *   excerpt: ExcerptRow[],
 * }} Anchor
 * `before` and `after` hold up to 2 texts of the neighbouring rows on the same
 * side, nearest first.
 * @typedef {{
 *   id: string,
 *   file: string,
 *   anchor: Anchor,
 *   body: string,
 *   resolved: boolean,
 *   [key: string]: unknown,
 * }} Comment
 */

const CONTEXT_ROWS = 2;
const EXCERPT_CHARS = 200;

/** @param {{ kind: string }} row */
export function sideOf(row) {
  if (row.kind === "remove") return "old";
  if (row.kind === "add" || row.kind === "context") return "new";
  return null;
}

const lineOf = (row, side) => (side === "old" ? row.oldLine : row.newLine);
const isHunkStart = (row) => row.kind === "meta" && row.text.startsWith("@@");

// Texts of same-side rows next to `index`, nearest first, within the hunk.
function neighbours(rows, index, side, step) {
  const texts = [];
  for (let i = index + step; i >= 0 && i < rows.length; i += step) {
    if (isHunkStart(rows[i])) break;
    const { kind } = rows[i];
    if (kind === "context" || sideOf(rows[i]) === side) texts.push(rows[i].text);
    if (texts.length >= CONTEXT_ROWS) break;
  }
  return texts;
}

/** Up to 2 non-meta rows before the row in its hunk, plus the row. */
export function excerptAt(rows, index) {
  const row = rows[index];
  if (!row || sideOf(row) === null) return [];
  const picked = [row];
  for (let i = index - 1; i >= 0 && picked.length <= CONTEXT_ROWS; i--) {
    if (isHunkStart(rows[i])) break;
    if (rows[i].kind !== "meta") picked.unshift(rows[i]);
  }
  return picked.map((r) => ({ kind: r.kind, text: r.text.slice(0, EXCERPT_CHARS) }));
}

/** @returns {Anchor | null} */
export function anchorAt(rows, index) {
  const row = rows[index];
  const side = row ? sideOf(row) : null;
  if (!row || !side) return null;
  return {
    side,
    line: lineOf(row, side),
    text: row.text,
    before: neighbours(rows, index, side, -1),
    after: neighbours(rows, index, side, 1),
    excerpt: excerptAt(rows, index),
  };
}

const matches = (expected, actual) =>
  expected.reduce((n, text, k) => n + (actual[k] === text ? 1 : 0), 0);

/**
 * Row index of the anchor's line, or null when it is gone (outdated).
 * Candidates are rows on the anchor's side with equal text; the best has the
 * most matching context texts, then the smallest distance to the old line, then
 * the lowest index.
 */
export function locateAnchor(rows, anchor) {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (sideOf(row) !== anchor.side || row.text !== anchor.text) continue;
    const score =
      matches(anchor.before ?? [], neighbours(rows, i, anchor.side, -1)) +
      matches(anchor.after ?? [], neighbours(rows, i, anchor.side, 1));
    const distance = Math.abs(lineOf(row, anchor.side) - anchor.line);
    if (
      !best ||
      score > best.score ||
      (score === best.score && distance < best.distance)
    ) {
      best = { index: i, score, distance };
    }
  }
  return best ? best.index : null;
}

/**
 * Outdated is decided against all given rows. Comments whose file is not in the
 * diff go to `missing`.
 * @param {Comment[]} comments
 * @param {{ path: string, rows: object[] }[]} files
 */
export function placeComments(comments, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byFile = new Map();
  const missing = [];
  for (const comment of comments) {
    const file = byPath.get(comment.file);
    if (!file) {
      missing.push(comment);
      continue;
    }
    if (!byFile.has(file.path)) byFile.set(file.path, { placed: [], outdated: [] });
    const entry = byFile.get(file.path);
    const index = locateAnchor(file.rows, comment.anchor);
    if (index === null) entry.outdated.push(comment);
    else entry.placed.push({ comment, index });
  }
  return { byFile, missing };
}
