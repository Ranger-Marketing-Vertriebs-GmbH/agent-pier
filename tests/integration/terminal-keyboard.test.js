import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
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
