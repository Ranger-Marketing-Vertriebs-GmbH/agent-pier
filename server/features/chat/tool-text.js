export const TOOL_TEXT_LIMIT = 16384;
export const TOOL_TEXT_HEAD = 12288;
export const TOOL_TEXT_TAIL = 4096;

const high = (code) => code >= 0xd800 && code <= 0xdbff;
const headEnd = (text, end) => (high(text.charCodeAt(end - 1)) ? end - 1 : end);
const tailStart = (text, start) => (high(text.charCodeAt(start - 1)) ? start + 1 : start);

// Long tool output stays reachable through the full-text endpoint; payloads carry
// only a head and tail so slow connections receive chats quickly.
export function truncateToolRow(row) {
  if (
    row?.role !== "tool" ||
    typeof row.text !== "string" ||
    row.text.length <= TOOL_TEXT_LIMIT
  )
    return { row, full: null };
  const full = row.text;
  return {
    row: {
      ...row,
      text: full.slice(0, headEnd(full, TOOL_TEXT_HEAD)),
      textTail: full.slice(tailStart(full, full.length - TOOL_TEXT_TAIL)),
      truncated: { length: full.length, bytes: Buffer.byteLength(full, "utf8") },
    },
    full,
  };
}
