// Validation of the body of a new review comment. A workspace is only a label: no
// code reads a path from it.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { ANCHOR_TEXT_CHARS } from "./review-anchor.js";

export const MAX_COMMENT_BYTES = 8192;
const MAX_WORKSPACE_CHARS = 512;
const MAX_FILE_CHARS = 4096;
const MAX_EXCERPT_ROWS = 3;
const MAX_EXCERPT_CHARS = 200;
const MAX_CONTEXT_ROWS = 2;
const EXCERPT_KINDS = new Set(["add", "remove", "context"]);

const invalid = () => problem(serverMessages.changes.invalidComment, 400);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A POSIX relative path: no empty, "." or ".." segments, backslashes or controls.
function relativePath(value, max) {
  if (typeof value !== "string" || value.length > max) throw invalid();
  if (/[\\\x00-\x1f\x7f]/.test(value)) throw invalid();
  for (const segment of value.split("/"))
    if (segment === "" || segment === "." || segment === "..") throw invalid();
  return value;
}

function textList(value, maxRows) {
  if (!Array.isArray(value) || value.length > maxRows) throw invalid();
  for (const text of value)
    if (typeof text !== "string" || text.length > ANCHOR_TEXT_CHARS) throw invalid();
  return [...value];
}

const position = (line) => {
  if (!Number.isSafeInteger(line) || line < 1) throw invalid();
  return line;
};
const side = (value) => {
  if (value !== "old" && value !== "new") throw invalid();
  return value;
};

function anchorInput(value) {
  if (!isObject(value)) throw invalid();
  if (typeof value.text !== "string" || value.text.length > ANCHOR_TEXT_CHARS)
    throw invalid();
  if (!Array.isArray(value.excerpt) || value.excerpt.length > MAX_EXCERPT_ROWS)
    throw invalid();
  const excerpt = value.excerpt.map((row) => {
    if (
      !isObject(row) ||
      !EXCERPT_KINDS.has(row.kind) ||
      typeof row.text !== "string" ||
      row.text.length > MAX_EXCERPT_CHARS
    )
      throw invalid();
    return { kind: row.kind, text: row.text };
  });
  return {
    side: side(value.side),
    line: position(value.line),
    text: value.text,
    before: textList(value.before, MAX_CONTEXT_ROWS),
    after: textList(value.after, MAX_CONTEXT_ROWS),
    excerpt,
  };
}

/**
 * Validates the request body of a new comment. Runs have no workspace.
 * @param {unknown} body
 * @param {{ kind: "session" | "run" }} scope
 */
export function commentInput(body, { kind }) {
  if (!isObject(body)) throw invalid();
  const workspace = body.workspace ?? "";
  if (typeof workspace !== "string") throw invalid();
  if (workspace !== "") {
    if (kind === "run") throw invalid();
    relativePath(workspace, MAX_WORKSPACE_CHARS);
  }
  if (typeof body.body !== "string" || !body.body.trim()) throw invalid();
  if (new TextEncoder().encode(body.body).length > MAX_COMMENT_BYTES)
    throw problem(serverMessages.changes.commentTooLong, 400);
  return {
    workspace,
    file: relativePath(body.file, MAX_FILE_CHARS),
    side: side(body.side),
    line: position(body.line),
    anchor: anchorInput(body.anchor),
    body: body.body,
  };
}
