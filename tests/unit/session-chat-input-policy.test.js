import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import { SessionOperations } from "../../server/features/sessions/session-operations.js";
const codexScreen = (line) =>
  `Synthetic output\n\n${line}\n\n  probe default · ~/project\n`;
function sessionManager() {
  const operations = new SessionOperations(() => Promise.resolve());
  const manager = {
    replacing: new Set(),
    events: [],
    paneId: "%1",
    cursorX: 2,
    target: () => "=synthetic",
    current: async () => ({
      id: "one",
      tool: "codex",
      accountId: "fixture",
      status: "running",
    }),
    serial: (operation, id) => operations.run(operation, id),
    tmux: async (args, options) => {
      if (args[0] === "display-message")
        return `${manager.paneId}|${process.pid}|1|${manager.cursorX}|2|120|35|0\n${manager.screen}`;
      manager.events.push({ args, input: options?.input });
      return "";
    },
  };
  return manager;
}

test("explicit fresh input permits an existing draft but cannot bypass recovery matching", async () => {
  const manager = sessionManager();
  manager.screen = codexScreen("\x1b[1m›\x1b[0m existing draft");
  manager.cursorX = 16;
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(
      tx.write("wrong", { allowComposerDraft: true, submitOnly: true }),
      { status: 409 },
    );
    await tx.write("hello", { allowComposerDraft: true });
  });
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["load-buffer", "paste-buffer", "send-keys"],
  );
});

test("explicit fresh input still refuses a replaced runtime before submitting", async () => {
  const manager = sessionManager();
  manager.screen = "Unrecognizable native screen";
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(
      tx.write("hello", {
        allowComposerDraft: true,
        onPhase: async (phase) => {
          if (phase === "submit-intent") manager.paneId = "%2";
        },
      }),
      { status: 409 },
    );
  });
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["load-buffer", "paste-buffer"],
  );
});

test("fresh chat input never pastes into Codex startup hook trust even before request polling", async () => {
  const { hookScreen } = await import("../fixtures/requests/codex-hook-trust.js");
  const manager = sessionManager();
  manager.screen = hookScreen();
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(tx.write("hello", { allowComposerDraft: true }), {
      status: 409,
    });
  });
  assert.deepEqual(manager.events, []);
});
