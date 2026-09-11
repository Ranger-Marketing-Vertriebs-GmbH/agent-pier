import test from "node:test";
import assert from "node:assert/strict";
import {
  shiftEnter,
  terminalKey,
} from "../../web/features/terminal/terminal-keyboard.js";

test("Shift+Enter is encoded as a distinct TUI newline", () => {
  assert.equal(
    terminalKey({ type: "keydown", key: "Enter", shiftKey: true }),
    shiftEnter,
  );
  assert.equal(terminalKey({ type: "keydown", key: "Enter", shiftKey: false }), null);
  assert.equal(terminalKey({ type: "keyup", key: "Enter", shiftKey: true }), null);
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "isComposing"])
    assert.equal(
      terminalKey({ type: "keydown", key: "Enter", shiftKey: true, [modifier]: true }),
      null,
    );
});
