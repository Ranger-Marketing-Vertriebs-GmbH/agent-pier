import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
import fs from "node:fs/promises";
import path from "node:path";
import { terminalKey } from "../../web/features/terminal/terminal-keyboard.js";

test("Shift+Enter survives the attached tmux client as native Alt+Enter, not plain submit", async (t) => {
  const f = await applicationFixture(t);
  const recorder = await createTuiInputRecorder(f);
  const account = f.application.accounts.create({ name: "Keyboard", tool: "codex" });
  const session = await f.application.sessions.create({
    id: "keyboard",
    name: "Keyboard",
    tool: "codex",
    accountId: account.id,
    cwd: f.home,
    command: recorder.command,
    args: recorder.args,
    env: { HOME: f.home },
  });
  await recorder.waitForText("ready");
  let ready;
  const output = new Promise((resolve) => {
    ready = resolve;
  });
  const client = await f.application.sessions.attach(session.id, { onData: ready });
  try {
    await output;
    await client.write("first");
    await client.write(
      terminalKey(
        { type: "keydown", key: "Enter", shiftKey: true },
        { bracketedPasteMode: true },
      ),
    );
    await client.write("second");
    await recorder.waitForText("second");
    assert.equal((await recorder.readBytes()).toString(), "first\x1b\rsecond");
    await client.write("\r");
    await recorder.waitForText("second\r");
    assert.equal((await recorder.readBytes()).toString(), "first\x1b\rsecond\r");
  } finally {
    client.dispose();
  }
});

test("regression: Enter written before the tmux client drew reaches the CLI as Enter", async (t) => {
  const f = await applicationFixture(t);
  const recorder = await createTuiInputRecorder(f);
  const account = f.application.accounts.create({ name: "Early key", tool: "codex" });
  const manager = f.application.sessions;
  const session = await manager.create({
    id: "early-key",
    name: "Early key",
    tool: "codex",
    accountId: account.id,
    cwd: f.home,
    command: recorder.command,
    args: recorder.args,
    env: { HOME: f.home },
  });
  await recorder.waitForText("ready");
  // A tmux client that starts slowly: its PTY stays in line mode meanwhile, which
  // turns a carriage return into a line feed (Ctrl-J) and would lose the Enter.
  const slow = path.join(f.root, "slow-tmux");
  const tmuxPath = manager.tmuxPath;
  await fs.writeFile(slow, `#!/bin/sh\nsleep 0.5\nexec "${tmuxPath}" "$@"\n`, {
    mode: 0o755,
  });
  manager.tmuxPath = slow;
  let drawn = false;
  let client;
  try {
    client = await manager.attach(session.id, { onData: () => (drawn = true) });
  } finally {
    manager.tmuxPath = tmuxPath;
  }
  try {
    assert.equal(drawn, false, "the client must not have drawn before the first key");
    // Written at once, as the terminal socket does with keys queued while it attached.
    await Promise.all([client.write("a"), client.write("\r"), client.write("b")]);
    await recorder.waitForText("b");
    assert.equal((await recorder.readBytes()).toString(), "a\rb");
  } finally {
    client.dispose();
  }
});
