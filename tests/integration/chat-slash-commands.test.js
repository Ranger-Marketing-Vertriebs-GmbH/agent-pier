import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chatTuiScreen,
  capturedChatTuiScreen,
  nativeDraftScreen,
} from "../helpers/chat-tui-fixture.js";
import { createTuiInputRecorder } from "../helpers/tui-input-recorder.js";
import { unconfirmedCommand } from "../../server/features/chat/delivery-commands.js";
import { applicationFixture } from "../helpers/application.js";

// tmux commands that only read state; everything else counts as input to the TUI.
const stateReads = new Set(["list-panes", "capture-pane", "show-options"]);

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: chat slash commands reach the TUI exactly once without queueing or bracketed paste`, async (t) => {
    const f = await applicationFixture(t);
    const session = { id: "slash", tool, accountId: "fixture", status: "running" };
    const manager = f.application.sessions;
    manager.get = manager.current = async () => session;
    const screen = await chatTuiScreen(tool);
    const calls = [];
    // Claude's prompt box shows the typed command until Enter submits it.
    let typed = "";
    manager.tmux = async (args) => {
      if (args[0] === "display-message")
        return capturedChatTuiScreen(nativeDraftScreen(tool, screen, typed));
      // State reads (a session list's `list-panes -a`) are not input to the TUI.
      if (stateReads.has(args[0])) return "";
      calls.push(args);
      if (args[0] === "send-keys") typed = args.includes("-l") ? args.at(-1) : "";
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
      // Local commands send no native event: the cleared prompt confirms them.
      const settled = unconfirmedCommand(tool, text) ? "accepted" : "handed-off";
      // A background session list (the 2.5 s operations poll, a live topic) may read
      // tmux state at any time; it must not count as keyboard input.
      const [first] = await Promise.all([send(), manager.list()]);
      assert.equal((await first.json()).status, settled);
      assert.equal((await (await send()).json()).status, settled);
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
    const recorder = await createTuiInputRecorder(
      f,
      tool === "claude" ? { claude: {} } : { native: { tool } },
    );
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
    const settled = unconfirmedCommand(tool, "/clear") ? "accepted" : "handed-off";
    assert.equal((await (await send()).json()).status, settled);
    await recorder.waitForText("/clear\r");
    assert.equal((await (await send()).json()).status, settled);
    assert.equal((await recorder.readBytes()).toString(), "/clear\r");
  });
}
