import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { inspectChatComposer } from "../sessions/session-chat-input.js";
import { claudePlaceholder } from "../sessions/claude-composer.js";

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
    // Narrow panes truncate the placeholder ("Press up to edit queu…").
    if (!claudePlaceholder(styled[row], pane, { queued: true })) return [];
    let index = row - 2;
    // Optional right-aligned native hint (effort, Ctrl+Y, …) or a blank row
    // above the ruled composer.
    if (
      /^\s*● \w+ · \/effort\s*$/.test(lines[index] || "") ||
      /^ {20,}\S[^\n]*$/.test(lines[index] || "")
    )
      index--;
    // Claude Code 2.1.2xx+: unindented rows, blank separators, send-now hint.
    const hint = sendNowHint(lines, lines[index]?.trim() ? index : index - 1);
    if (hint >= 0)
      return hashes(claudeQueue(styled, lines, hint - 1), pane, pane.width - 2);
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
  return hashes(values, pane);
}

const gray = "\x1b\\[38;2;153;153;153m";
const claudeHead = new RegExp(
  `^(?:\x1b\\[[0-9;]*m)*❯[ \u00a0]${gray}([^\x1b]+)\x1b\\[39m[ ]*(?:\x1b\\[49m)?$`,
);
const claudeContinuation = new RegExp(`^(?:\x1b\\[[0-9;]*m)*  ${gray}[^\x1b]*\x1b\\[39m`);
// NO_COLOR/FORCE_COLOR=0: the same layout without any styling.
const plainHead = /^❯[ \u00a0]([^\x1b]+?) *$/;
const plainContinuation = /^  \S[^\x1b]*$/;
const sendNow = "ctrl+x ctrl+s to send now";

/** Top row of the send-now hint ending at `end`; narrow panes wrap it. */
function sendNowHint(lines, end) {
  let text = "";
  for (let index = end; index >= Math.max(0, end - 3); index--) {
    if (!/^  \S/.test(lines[index])) return -1;
    text = text ? `${lines[index].trim()} ${text}` : lines[index].trim();
    if (text === sendNow) return index;
    if (!sendNow.endsWith(` ${text}`)) return -1;
  }
  return -1;
}

/** Queue rows above the send-now hint, bottom-up; multi-row entries stay unknown. */
function claudeQueue(styled, lines, start) {
  const colorless = !styled.some((line) => /\x1b\[[34]8;/.test(line));
  const head = colorless ? plainHead : claudeHead;
  const continuation = colorless ? plainContinuation : claudeContinuation;
  const values = [];
  let continued = false;
  for (let index = start; index >= 0; index--) {
    if (!lines[index].trim()) {
      // Entries are separated by exactly one blank row; a wider gap (or a
      // blank below a headless continuation) ends the queue region, so older
      // transcript prompts above a missing spinner row are never read.
      if (continued || !lines[index - 1]?.trim()) return values;
      continue;
    }
    if (continuation.test(styled[index])) {
      continued = true;
      continue;
    }
    const match = head.exec(styled[index]);
    if (!match) break;
    // A wrapped row and an embedded newline look alike: never confirm either.
    if (!continued) values.unshift(match[1]);
    continued = false;
  }
  return values;
}

// Never turn an ellipsis/paste summary or a clipped terminal row into a receipt.
// Claude 2.1.x wraps queued rows (also long tokens, CJK and emoji) instead of
// clipping them after width - 3 cells, so a single row may use that width.
function hashes(values, pane, limit = pane.width - 10) {
  return values
    .filter(
      (text) => text && text.length < limit && !/[\n\r…]|\[Pasted|\.\.\.$/.test(text),
    )
    .slice(0, 20)
    .map(inputHash);
}
