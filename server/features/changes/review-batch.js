// Formats open review comments as one plain-text batch for the agent. Shared by
// the server and the browser bundle: no Buffer, no node: imports. The text is
// fixed English because it is agent input, not UI copy.
import { excerptAt, placeComments } from "./review-anchor.js";

/** @typedef {import("./review-anchor.js").Comment} Comment */
/**
 * @typedef {{
 *   id: string,
 *   location: string,
 *   line: number,
 *   side?: "old" | "new",
 *   outdated: boolean,
 *   excerpt: import("./review-anchor.js").Anchor["excerpt"],
 *   body: string,
 * }} Entry
 */

/** Byte limit of the review gate's feedback text. */
export const REVIEW_FEEDBACK_LIMIT = 32768;

/** UTF-8 bytes of a text, counted the same way in Node and the browser. */
export const feedbackBytes = (text) => new TextEncoder().encode(text).length;

const MARKERS = { add: "+ ", remove: "- ", context: "  " };
const INDENT = "   ";

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lineOfRow = (row, side) => (side === "old" ? row.oldLine : row.newLine);

/**
 * Entries of the open comments, relocated against the current diffs.
 * @param {Comment[]} comments
 * @param {Map<string, object[]>} diffs keyed by comment.workspace
 * @returns {Entry[]}
 */
export function reviewEntries(comments, diffs) {
  const open = comments.filter((c) => c.status === "open");
  const placement = new Map();
  const groups = new Map();
  for (const c of open) {
    const key = c.workspace ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [workspace, group] of groups) {
    const files = diffs.get(workspace);
    if (!files) continue;
    const rowsByPath = new Map(files.map((f) => [f.path, f.rows]));
    const { byFile } = placeComments(group, files);
    for (const [path, { placed }] of byFile) {
      for (const { comment, index } of placed) {
        placement.set(comment, { rows: rowsByPath.get(path), index });
      }
    }
  }
  const items = open.map((c) => {
    const workspace = c.workspace ?? "";
    const found = placement.get(c);
    let line = c.anchor?.line ?? c.line ?? 0;
    let excerpt = Array.isArray(c.anchor?.excerpt) ? c.anchor.excerpt : [];
    if (found) {
      line = lineOfRow(found.rows[found.index], c.anchor.side);
      excerpt = excerptAt(found.rows, found.index);
    }
    return {
      workspace,
      entry: {
        id: c.id,
        location: `${workspace ? `${workspace}/` : ""}${c.file}`,
        line,
        side: c.anchor?.side ?? c.side,
        outdated: !found,
        excerpt,
        body: c.body,
      },
    };
  });
  items.sort(
    (a, b) =>
      compare(a.workspace !== "", b.workspace !== "") ||
      compare(a.workspace, b.workspace) ||
      compare(a.entry.location, b.entry.location) ||
      a.entry.line - b.entry.line,
  );
  return items.map((i) => i.entry);
}

const longestBackticks = (text) =>
  Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));

const indent = (text) =>
  text
    .split("\n")
    .map((line) => INDENT + line)
    .join("\n");

function formatEntry(entry, number) {
  const removed = entry.side === "old" ? " (removed line)" : "";
  const head = `${number}. ${entry.location}:${entry.line}${removed}${entry.outdated ? " (outdated)" : ""}`;
  const lines = [head];
  if (entry.excerpt.length > 0) {
    const longest = Math.max(
      longestBackticks(entry.body),
      ...entry.excerpt.map((row) => longestBackticks(row.text)),
    );
    const fence = "`".repeat(Math.max(3, longest + 1));
    lines.push(
      INDENT + fence,
      ...entry.excerpt.map((row) => INDENT + (MARKERS[row.kind] ?? "  ") + row.text),
      INDENT + fence,
    );
  }
  lines.push(indent(entry.body));
  return lines.join("\n");
}

/** @param {Entry[]} entries */
export function formatReviewBatch(entries) {
  if (entries.length === 0) return "";
  return [
    `Review notes (${entries.length}):`,
    "Paths are relative to the session directory (for runs: the run's workspace).",
    "",
    entries.map((entry, i) => formatEntry(entry, i + 1)).join("\n\n"),
  ].join("\n");
}

/** Free text first, then the batch; empty parts disappear. */
export function combineFeedback(freeText, batch) {
  return [freeText, batch]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}
