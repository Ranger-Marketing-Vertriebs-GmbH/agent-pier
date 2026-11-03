import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { inspectChatComposer } from "../sessions/session-chat-input.js";
import { cliDriver } from "../clis/drivers.js";

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
  // Each CLI reads its own queue rows (see `<id>/tui.js`); none reads as empty.
  return (
    cliDriver(tool).tui.queuedInputs?.({ raw, styled, lines, row, pane, hashes }) ?? []
  );
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
