import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { inspectChatComposer } from "../sessions/session-chat-input.js";

export const inputHash = (text) =>
  createHash("sha256")
    .update(JSON.stringify([text, true]))
    .digest("hex");

/** Current native chrome only. Incomplete, wrapped and duplicate text stays unknown. */
export function nativeInputQueue(tool, raw, pane) {
  if (typeof raw !== "string" || raw.length > 256 * 1024 || !pane) return [];
  const styled = raw.split("\n");
  const lines = styled.map(stripVTControlCharacters);
  const row = pane.cursorY;
  if (inspectChatComposer(tool, raw, pane).state === "unknown") return [];
  const values = [];
  if (tool === "codex") {
    let end = row - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    let start = end;
    while (start >= 0 && /^  ↳ .+/.test(lines[start])) start--;
    let header = start;
    while (header >= Math.max(0, start - 3) && !styled[header].startsWith("\x1b[2m• "))
      header--;
    if (
      header < 0 ||
      !/^• Messages to be submitted after next tool call \(press esc to interrupt and send immediately\)$/.test(
        lines
          .slice(header, start + 1)
          .map((line) => line.trim())
          .join(" "),
      ) ||
      !styled[header]?.startsWith("\x1b[2m• ")
    )
      return [];
    for (let i = start + 1; i <= end; i++) {
      if (!/^\x1b\[2m  ↳ [^\x1b]+\x1b\[0m$/.test(styled[i])) return [];
      values.push(lines[i].slice(4));
    }
  } else if (tool === "claude") {
    if (!lines[row]?.includes("Press up to edit queued messages")) return [];
    let index = row - 2;
    // Optional native effort indicator directly above the ruled composer.
    if (/^\s*● \w+ · \/effort\s*$/.test(lines[index] || "")) index--;
    for (; index >= 0; index--) {
      const match = styled[index].match(
        /^  \x1b\[38;2;80;80;80m\x1b\[48;2;55;55;55m❯ \x1b\[38;2;255;255;255m([^\x1b]+)\x1b\[39m *\x1b\[49m$/,
      );
      if (!match) break;
      values.unshift(match[1]);
    }
  } else if (tool === "opencode") {
    for (let i = 1; i < row - 3; i++) {
      if (!/^\s*┃\s+QUEUED\s*$/.test(lines[i]) || !/\x1b\[1m/.test(styled[i])) continue;
      const match = styled[i - 1].match(
        /\x1b\[38;2;238;238;238m([^\x1b]+)\x1b\[38;2;255;255;255m/,
      );
      if (
        match &&
        /^\s*┃\s*$/.test(lines[i - 2] || "") &&
        /^\s*┃\s*$/.test(lines[i + 1] || "")
      )
        values.push(match[1]);
    }
  }
  // Never turn an ellipsis/paste summary or a clipped terminal row into a receipt.
  return values
    .filter(
      (text) =>
        text && text.length < pane.width - 10 && !/[\n\r…]|\[Pasted|\.\.\.$/.test(text),
    )
    .slice(0, 20)
    .map(inputHash);
}
