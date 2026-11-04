// A search result's note opens on the memory page: the two root notes, the Dream
// Diary or a Markdown note under memory/. Anything else (an absolute path, a step
// out of the workspace, another file) stays a plain result.
export const openableNote = (path) =>
  typeof path === "string" &&
  (["MEMORY.md", "USER.md", "DREAMS.md"].includes(path) ||
    (/^memory\/[^\\]+\.md$/.test(path) && !path.split("/").includes("..")));

/**
 * The characters of lines `startLine` to `endLine` (1-based, inclusive) of
 * `content`, as `{ start, end }` offsets for a textarea's selection; a line past the
 * end selects the end, a missing or invalid range the start.
 */
export function lineRange(content, startLine, endLine = startLine) {
  const text = typeof content === "string" ? content : "";
  if (!Number.isInteger(startLine) || startLine < 1) return { start: 0, end: 0 };
  const last = Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine;
  const offsetOf = (line) => {
    let offset = 0;
    for (let n = 1; n < line; n++) {
      const next = text.indexOf("\n", offset);
      if (next < 0) return text.length;
      offset = next + 1;
    }
    return offset;
  };
  const start = offsetOf(startLine);
  const lineEnd = text.indexOf("\n", offsetOf(last));
  return { start, end: Math.max(start, lineEnd < 0 ? text.length : lineEnd) };
}
