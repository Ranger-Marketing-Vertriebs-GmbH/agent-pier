import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chatTuiScreen,
  renderChatTuiScreen,
  capturedChatTuiScreen,
} from "../helpers/chat-tui-fixture.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
import { applicationFixture } from "../helpers/application.js";

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: chat slash commands reach the TUI exactly once without queueing or bracketed paste`, async (t) => {
    const f = await applicationFixture(t);
    const session = { id: "slash", tool, accountId: "fixture", status: "running" };
    const manager = f.application.sessions;
    manager.get = manager.current = async () => session;
    const screen = await chatTuiScreen(tool);
    const calls = [];
    manager.tmux = async (args) => {
      if (args[0] === "display-message") return capturedChatTuiScreen(screen);
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
        ["send-keys", "send-keys"],
      );
      assert.deepEqual(calls[0].slice(-2), ["--", text]);
      assert.ok(calls[0].includes("-l"));
      assert.equal(calls[1].at(-1), "Enter");
    }
  });
}

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: slash input arrives as native keystrokes through owned tmux`, async (t) => {
    const f = await applicationFixture(t);
    const recorder = await createTuiInputRecorder(f, {
      screen: renderChatTuiScreen(await chatTuiScreen(tool)),
    });
    const account = f.application.accounts.create({ name: "Input fixture", tool });
    const session = await f.application.sessions.create({
      id: "slash-native",
      name: "Native input",
      accountId: account.id,
      tool,
      cwd: f.home,
      command: recorder.command,
      args: recorder.args,
      env: { HOME: f.home },
    });
    f.application.requests.list = async () => ({ requests: [] });
    f.application.requests.hasPending = () => false;
    f.application.models.guardInput = async () => {};
    f.application.history.queue = async () =>
      assert.fail("Unexpected native message queue");
    await recorder.waitForText("ready");
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
    await recorder.waitForText("/clear\r");
    assert.equal((await (await send()).json()).status, "handed-off");
    assert.equal((await recorder.readBytes()).toString(), "/clear\r");
  });
}
