import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  recordManualInput,
  assertManualInputSettled,
} from "../../server/features/sessions/manual-input-guard.js";

test("automatic terminal color replies do not block chat as unrendered user input", async () => {
  for (const reply of [
    "\x1b]11;rgb:1010/1111/1515\x1b\\",
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1b]4;0;rgb:0000/0000/0000\x1b\\",
    "\x1b[?1;2c\x1b[32;3R\x1b]12;rgb:ffff/ffff/ffff\x1b\\",
  ]) {
    const manager = { pendingTerminalInput: new Set() };
    await recordManualInput(manager, { id: "isolated", tool: "claude" }, reply);
    assert.doesNotThrow(() =>
      assertManualInputSettled(manager, "isolated", { composer: { state: "empty" } }),
    );
  }
});

test("text alongside terminal replies still blocks chat until it renders", async () => {
  for (const text of [
    "draft",
    "\x1b]11;rgb:1010/1111/1515\x1b\\draft",
    "\x1b[200~draft\x1b[201~",
  ]) {
    const manager = { pendingTerminalInput: new Set() };
    await recordManualInput(manager, { id: "isolated", tool: "claude" }, text);
    assert.throws(
      () =>
        assertManualInputSettled(manager, "isolated", { composer: { state: "empty" } }),
      { status: 409 },
    );
  }
});

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
