import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  recordManualInput,
  assertManualInputSettled,
} from "../../server/features/sessions/manual-input-guard.js";

test("visible manual input releases the render guard before terminal submission", async () => {
  const fixture = JSON.parse(
    await fs.readFile(
      new URL("../fixtures/tui-input/codex-idle.json", import.meta.url),
      "utf8",
    ),
  );
  const session = { id: "isolated", tool: "codex" };
  let raw = fixture.raw;
  const manager = {
    pendingTerminalInput: new Set(),
    target: () => "isolated-target",
    tmux: async () => `7|${fixture.pane.cursorY}|${fixture.pane.width}\n${raw}`,
  };
  await recordManualInput(manager, session, "draft");
  assert.throws(
    () => assertManualInputSettled(manager, session.id, { composer: { state: "empty" } }),
    { status: 409 },
  );
  const rows = raw.split("\n");
  rows[fixture.pane.cursorY] = "\x1b[1m›\x1b[0m draft";
  raw = rows.join("\n");
  await recordManualInput(manager, session, "\r");
  assert.equal(manager.pendingTerminalInput.size, 0);
  assert.doesNotThrow(() =>
    assertManualInputSettled(manager, session.id, { composer: { state: "empty" } }),
  );
  await recordManualInput(manager, session, "\x1b[A");
  assert.equal(manager.pendingTerminalInput.size, 0);
});
