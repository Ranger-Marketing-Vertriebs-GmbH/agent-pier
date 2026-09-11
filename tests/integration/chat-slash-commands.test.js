import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: chat slash commands reach the TUI exactly once without queueing or bracketed paste`, async (t) => {
    const f = await applicationFixture(t);
    const session = { id: "slash", tool, accountId: "fixture", status: "running" };
    const manager = f.application.sessions;
    manager.get = manager.current = async () => session;
    const calls = [];
    manager.tmux = async (args) => {
      calls.push(args);
      return "";
    };
    f.application.requests.list = async () => ({ requests: [] });
    f.application.requests.hasPending = () => false;
    f.application.models.guardInput = async () => {};
    f.application.bindings.resolve = async () => ({ id: "native" });
    f.application.history.queue = async () =>
      assert.fail("Slash command reached message queue");
    for (const text of ["/clear", "/new", "/compact", "/model", "/rename New name"]) {
      calls.length = 0;
      const body = {
        deliveryId: randomUUID(),
        deliveryScope: JSON.stringify([session.id, session.accountId, tool, null]),
        text,
        submit: true,
      };
      const send = () => f.request("/api/sessions/slash/input", { method: "POST", body });
      assert.equal((await (await send()).json()).status, "handed-off");
      assert.equal((await (await send()).json()).status, "handed-off");
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["capture-pane", "send-keys", "send-keys"],
      );
      assert.deepEqual(calls[1].slice(-2), ["--", text]);
      assert.ok(calls[1].includes("-l"));
      assert.equal(calls[2].at(-1), "Enter");
    }
  });
}

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: slash input arrives as native keystrokes through owned tmux`, async (t) => {
    const f = await applicationFixture(t);
    const { default: fs } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const script = path.join(f.root, "native-input.mjs");
    const capture = path.join(f.root, "keys");
    const ready = path.join(f.root, "ready");
    await fs.writeFile(
      script,
      `import fs from 'node:fs';
process.stdin.setRawMode(true);
process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(capture)}, data));
process.stdout.write('\\x1b[?2004h');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
`,
    );
    const account = f.application.accounts.create({ name: "Input fixture", tool });
    const session = await f.application.sessions.create({
      id: "slash-native",
      name: "Native input",
      accountId: account.id,
      tool,
      cwd: f.home,
      command: process.execPath,
      args: [script],
      env: { HOME: f.home },
    });
    f.application.requests.list = async () => ({ requests: [] });
    f.application.requests.hasPending = () => false;
    f.application.models.guardInput = async () => {};
    f.application.history.queue = async () =>
      assert.fail("Unexpected native message queue");
    async function until(read, expected) {
      for (let n = 0; n < 150; n++) {
        if ((await read().catch(() => "")) === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(await read(), expected);
    }
    await until(() => fs.readFile(ready, "utf8"), "ready");
    const body = {
      deliveryId: randomUUID(),
      deliveryScope: JSON.stringify([
        session.id,
        session.accountId,
        tool,
        session.createdAt,
      ]),
      text: "/clear",
      submit: true,
    };
    const send = () =>
      f.request(`/api/sessions/${session.id}/input`, { method: "POST", body });
    assert.equal((await (await send()).json()).status, "handed-off");
    await until(() => fs.readFile(capture, "utf8"), "/clear\r");
    assert.equal((await (await send()).json()).status, "handed-off");
    assert.equal(await fs.readFile(capture, "utf8"), "/clear\r");
  });
}

test("paths, quoted slash mentions and multiline prompts retain native message queue delivery", async (t) => {
  const f = await applicationFixture(t);
  const manager = f.application.sessions;
  manager.current = async () => ({ id: "slash", tool: "codex", status: "running" });
  manager.tmux = async () => assert.fail("Ordinary prompt reached terminal input");
  for (const text of [
    "/tmp/project/file.js",
    "Please explain /clear",
    "`/clear`",
    "/clear\n",
    "/clear\r\n",
    "/clear\nExplain this command",
    "/rename foo\tbar",
    "/rename foo\u0003",
    "/rename \u001b[A",
    "/clear\t",
  ]) {
    let queued = false;
    await manager.input("slash", text, true, undefined, async () => {
      queued = true;
      return true;
    });
    assert.equal(queued, true, JSON.stringify(text));
  }
});
