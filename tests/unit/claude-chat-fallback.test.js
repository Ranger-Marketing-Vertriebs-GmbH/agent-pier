import test from "node:test";
import assert from "node:assert/strict";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";

// Chat must never be refused because of terminal state: a draft that cannot be
// replaced is sent along, an unreadable prompt gets paste and Enter.
const quick = {
  dialog: { settleMs: 40, waitMs: 120 },
  clear: { settleMs: 30, timeoutMs: 600 },
};
const busy = "\x1b[38;2;215;119;87m✻\x1b[39m Working… (42s · esc to interrupt)";

function stuckModel(options) {
  const model = claudePromptModel(options);
  const key = model.key;
  // Claude ignores the editing keys (for example while a long turn redraws).
  model.key = (name) =>
    ["C-e", "C-u", "BSpace", "DC"].includes(name) ? model.keys.push(name) : key(name);
  return model;
}

async function send(model, text = "chat message") {
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  const notices = [];
  const phases = [];
  const result = await chat.withChatInput(manager, "one", (tx) =>
    tx.write(text, {
      allowComposerDraft: true,
      onNotice: async (code) => notices.push(code),
      onPhase: async (phase) => phases.push(phase),
    }),
  );
  return { manager, notices, phases, result };
}

test("a replaceable draft is replaced without a notice", async () => {
  const model = claudePromptModel({ draft: "typed in the terminal" });
  const { notices } = await send(model);
  assert.deepEqual(model.submitted, ["chat message"]);
  assert.deepEqual(notices, []);
});

test("a draft that cannot be cleared is sent together with the chat text", async () => {
  const model = stuckModel({ draft: "typed in the terminal" });
  const { notices, phases, result, manager } = await send(model);
  assert.deepEqual(model.submitted, ["typed in the terminalchat message"]);
  assert.deepEqual(notices, ["CHAT_APPENDED_TO_DRAFT"]);
  assert.deepEqual(result.notices, ["CHAT_APPENDED_TO_DRAFT"]);
  assert.deepEqual(phases, ["paste-intent", "pasted", "submit-intent", "submitted"]);
  // One paste, one Enter; never Escape or Ctrl-C.
  assert.equal(manager.events.filter((e) => e.args[0] === "paste-buffer").length, 1);
  assert.equal(model.keys.filter((key) => key === "Enter").length, 1);
  assert.ok(!model.keys.some((key) => ["Escape", "C-c"].includes(key)));
});

test("regression: busy Claude at 50x34 with a typed draft that will not clear", async () => {
  const model = stuckModel({
    draft: "half-typed idea\nsecond line",
    width: 50,
    height: 34,
    status: busy,
  });
  const { notices } = await send(model, "please also check the tests");
  assert.deepEqual(model.submitted, [
    "half-typed idea\nsecond lineplease also check the tests",
  ]);
  assert.deepEqual(notices, ["CHAT_APPENDED_TO_DRAFT"]);
});

test("a key budget exhausted mid-clear falls back to appending", async () => {
  const model = claudePromptModel({ draft: "one\ntwo\nthree\nfour\nfive\nsix" });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = { ...quick, clear: { settleMs: 30, maxKeys: 4 } };
  const result = await chat.withChatInput(manager, "one", (tx) =>
    tx.write("chat", { allowComposerDraft: true }),
  );
  assert.deepEqual(result.notices, ["CHAT_APPENDED_TO_DRAFT"]);
  assert.equal(model.submitted.length, 1);
  assert.ok(model.submitted[0].endsWith("chat"));
});

test("an unreadable Claude screen gets paste and Enter with a notice", async () => {
  const model = claudePromptModel();
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  model.screen = () => ({
    raw: "Synthetic output\nUnusual layout without a prompt box\n",
    pane: { cursorX: 4, cursorY: 1, width: 80, height: 35 },
  });
  const result = await chat.withChatInput(manager, "one", (tx) =>
    tx.write("chat message", { allowComposerDraft: true }),
  );
  assert.deepEqual(result.notices, ["CHAT_PROMPT_UNREADABLE"]);
  assert.deepEqual(
    manager.events.map((event) => event.args[0]),
    ["load-buffer", "paste-buffer", "send-keys"],
  );
  assert.deepEqual(manager.events.at(-1).args.slice(-1), ["Enter"]);
});

test("a submit Claude does not take stays unconfirmed, never retried", async () => {
  const model = stuckModel({ draft: "draft", ignoreEnter: true });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = { ...quick, confirm: { timeoutMs: 100 } };
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(tx.write("chat", { allowComposerDraft: true }), {
      code: "CHAT_SUBMIT_UNCONFIRMED",
    });
  });
  assert.equal(model.keys.filter((key) => key === "Enter").length, 1);
});
