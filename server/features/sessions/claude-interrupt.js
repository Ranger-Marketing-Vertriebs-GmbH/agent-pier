import fs from "node:fs/promises";

// Enough for the last rows; a partial first line is dropped.
const TAIL_BYTES = 64 * 1024;
const marker = /^\[Request interrupted by user(?: for tool use)?\]$/;
const text = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("")
      : "";

/**
 * Claude Code sends no hook when Esc interrupts a turn; its transcript records a
 * user row "[Request interrupted by user]" instead. Returns that row's time when it
 * is the newest conversation row and newer than `since`, otherwise null.
 */
export async function claudeInterruptAt(file, since) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const content = buffer.toString("utf8");
    const lines = content.split("\n");
    if (size > length) lines.shift();
    // The CLI may be in the middle of appending a record.
    if (!content.endsWith("\n")) lines.pop();
    for (const line of lines.reverse()) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !row ||
        row.isSidechain ||
        row.isMeta ||
        !["user", "assistant"].includes(row.type)
      )
        continue;
      if (row.type !== "user" || !marker.test(text(row.message?.content).trim()))
        return null;
      const at = Date.parse(row.timestamp);
      return Number.isFinite(at) && at > since ? at : null;
    }
    return null;
  } finally {
    await handle.close();
  }
}
