import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../../server/features/sessions/session-chat-input.js";

test("Claude accepts its exact empty prompt without an inverse-video cursor", () => {
  for (const width of [50, 120]) {
    const border = "─".repeat(width);
    const screen = (line) =>
      `Synthetic response\n\x1b[38;2;136;136;136m${border}\n${line}\n\x1b[38;2;136;136;136m${border}\n`;
    const pane = { cursorX: 2, cursorY: 2, width, height: 5 };
    const raw = screen("\x1b[39m❯ ");
    assert.deepEqual(chat.inspectChatComposer("claude", raw, pane), {
      state: "empty",
      text: "",
    });
    for (const line of ["❯ draft", "❯  ", "❯ [Pasted text #1]", "❯ \nwrapped", "❯ "]) {
      assert.equal(
        chat.inspectChatComposer("claude", screen(line), pane).state,
        "unknown",
      );
    }
    for (const invalid of [
      { ...pane, cursorX: 3 },
      { ...pane, cursorY: 0 },
      { ...pane, width: width + 1 },
    ]) {
      assert.equal(chat.inspectChatComposer("claude", raw, invalid).state, "unknown");
    }
    assert.equal(
      chat.inspectChatComposer("claude", raw.replace(border, "Allow this tool?"), pane)
        .state,
      "unknown",
    );
  }
});
