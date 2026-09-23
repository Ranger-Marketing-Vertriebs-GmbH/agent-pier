import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import {
  claudeComposerState,
  clearClaudeComposer,
  confirmClaudeSubmit,
} from "../../server/features/sessions/claude-composer.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";

// Real Claude Code 2.1.280 frames captured through a private tmux server.
const screens = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-screens.json", import.meta.url),
  ),
);
const state = ({ raw, pane }) =>
  claudeComposerState(raw, pane, chat.inspectChatComposer("claude", raw, pane)).state;

test("Claude readiness distinguishes the prompt box from native dialogs", () => {
  assert.equal(state(screens.idle), "empty");
  for (const name of ["queueOne", "queueTwo", "queueMixed"])
    assert.equal(state(screens[name]), "empty", name);
  for (const name of ["multilineDraft", "imageDraft", "pastedDraft"])
    assert.equal(state(screens[name]), "draft", name);
  for (const name of ["permission", "rewind", "modelPicker"])
    assert.equal(state(screens[name]), "dialog", name);
  assert.equal(
    state({
      raw: "Synthetic output\nWorking",
      pane: { ...screens.idle.pane, cursorY: 1 },
    }),
    "unknown",
  );
});

function transaction(model) {
  const manager = claudeModelManager(model);
  const snapshot = async () => {
    const { raw, pane } = model.screen();
    return { raw, pane, composer: chat.inspectChatComposer("claude", raw, pane) };
  };
  return { manager, snapshot };
}

test("Claude draft replacement clears every draft shape without Escape or Ctrl-C", async () => {
  for (const [draft, cursor] of [
    ["single line draft"],
    ["first line\nsecond line\nthird line"],
    ["[Image #1]look at\nsecond line"],
    ["alpha\nbeta\ngamma", { line: 0, col: 0 }],
    ["alpha beta gamma", { line: 0, col: 6 }],
  ]) {
    const model = claudePromptModel({ draft, cursor });
    const { manager, snapshot } = transaction(model);
    const fresh = await clearClaudeComposer(
      manager,
      { id: "one" },
      await snapshot(),
      snapshot,
      { settleMs: 30 },
    );
    assert.deepEqual(model.lines, [""], draft);
    assert.equal(state(fresh), "empty");
    assert.ok(!model.keys.some((key) => ["Escape", "C-c"].includes(key)));
  }
});

test("Claude draft replacement never types into a dialog and reports no progress", async () => {
  const dialog = claudePromptModel({ dialog: screens.permission });
  const x = transaction(dialog);
  await assert.rejects(
    clearClaudeComposer(x.manager, { id: "one" }, await x.snapshot(), x.snapshot),
    { status: 409, code: "CHAT_COMPOSER_DIALOG" },
  );
  assert.deepEqual(dialog.keys, []);

  // A prompt that ignores editing keys cannot be verified as cleared.
  const stuck = claudePromptModel({ draft: "old draft" });
  stuck.key = (name) => stuck.keys.push(name);
  const y = transaction(stuck);
  await assert.rejects(
    clearClaudeComposer(y.manager, { id: "one" }, await y.snapshot(), y.snapshot, {
      settleMs: 30,
    }),
    { status: 409, code: "CHAT_COMPOSER_NOT_CLEARED" },
  );
  assert.deepEqual(stuck.lines, ["old draft"]);
});

test("Claude submit confirmation requires the emptied prompt", async () => {
  const model = claudePromptModel({ draft: "sent text" });
  const { snapshot } = transaction(model);
  await assert.rejects(confirmClaudeSubmit(snapshot, { timeoutMs: 60 }), {
    status: 409,
    code: "CHAT_SUBMIT_UNCONFIRMED",
  });
  model.key("Enter");
  await confirmClaudeSubmit(snapshot, { timeoutMs: 60 });
  // A native slash command may replace the prompt with its own picker.
  model.dialog = screens.modelPicker;
  await confirmClaudeSubmit(snapshot, { slash: true, timeoutMs: 60 });
  await assert.rejects(confirmClaudeSubmit(snapshot, { timeoutMs: 60 }), {
    code: "CHAT_SUBMIT_UNCONFIRMED",
  });
});

// Quick native waits for the synthetic prompt model.
const quick = { dialog: { settleMs: 40, waitMs: 120 }, clear: { settleMs: 30 } };

test("fresh Claude chat input closes an open menu with one Escape, then sends", async () => {
  for (const name of ["rewind", "modelPicker"]) {
    const model = claudePromptModel({ dialog: screens[name] });
    const manager = claudeModelManager(model);
    manager.chatInputTiming = quick;
    const notices = [];
    const result = await chat.withChatInput(manager, "one", (tx) =>
      tx.write("hello", {
        allowComposerDraft: true,
        onNotice: async (code) => notices.push(code),
      }),
    );
    assert.deepEqual(model.submitted, ["hello"], name);
    // Nothing ever reached the menu but a single Escape.
    assert.deepEqual(model.keys, ["Escape", "Enter"], name);
    assert.deepEqual(model.dialogInput, [], name);
    assert.deepEqual(notices, ["CHAT_DIALOG_CLOSED"], name);
    assert.deepEqual(result.notices, ["CHAT_DIALOG_CLOSED"], name);
  }
});

test("a native question is never closed or typed into; the message waits", async () => {
  const model = claudePromptModel({ dialog: screens.permission });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(tx.write("hello", { allowComposerDraft: true }), {
      status: 409,
      code: "CHAT_QUESTION_OPEN",
    });
  });
  // Escape would deny the permission; nothing is sent at all.
  assert.deepEqual(model.keys, []);
  assert.deepEqual(manager.events, []);
});

test("a menu that Escape does not close is refused without a byte after bounded presses", async () => {
  const model = claudePromptModel({ dialog: screens.rewind, escapeCloses: false });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(tx.write("hello", { allowComposerDraft: true }), {
      status: 409,
      code: "CHAT_DIALOG_NOT_CLOSED",
    });
  });
  assert.deepEqual(model.keys, ["Escape", "Escape", "Escape"]);
  assert.deepEqual(model.dialogInput, []);
  assert.ok(!manager.events.some((event) => event.args[0] === "paste-buffer"));
  // While the message waits, later attempts never press Escape again.
  model.keys.length = 0;
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(
      tx.write("hello", { allowComposerDraft: true, closeMenus: false }),
      { code: "CHAT_DIALOG_NOT_CLOSED" },
    );
  });
  assert.deepEqual(model.keys, []);
});

test("a menu closed in the TUI during the short wait still gets the message", async () => {
  const model = claudePromptModel({ dialog: screens.rewind, escapeCloses: false });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = { ...quick, dialog: { settleMs: 40, waitMs: 3000 } };
  setTimeout(() => (model.dialog = null), 400);
  await chat.withChatInput(manager, "one", (tx) =>
    tx.write("hello", { allowComposerDraft: true }),
  );
  assert.deepEqual(model.submitted, ["hello"]);
  assert.deepEqual(model.dialogInput, []);
});

test("an unknown menu without an Escape footer receives no key at all", async () => {
  const raw = screens.rewind.raw
    .replace("Enter to continue · Esc to cancel", "Enter to continue")
    .replace("Rewind", "Choose");
  assert.notEqual(raw, screens.rewind.raw);
  const model = claudePromptModel({ dialog: { ...screens.rewind, raw } });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(tx.write("hello", { allowComposerDraft: true }), {
      code: "CHAT_DIALOG_NOT_CLOSED",
    });
  });
  assert.deepEqual(model.keys, []);
  assert.deepEqual(manager.events, []);
});

test("fresh Claude chat input replaces a restored draft and confirms the submit", async () => {
  const model = claudePromptModel({ draft: "interrupted prompt\nsecond line" });
  const manager = claudeModelManager(model);
  const phases = [];
  await chat.withChatInput(manager, "one", (tx) =>
    tx.write("new message", {
      allowComposerDraft: true,
      onPhase: async (phase) => phases.push(phase),
    }),
  );
  assert.deepEqual(model.submitted, ["new message"]);
  assert.deepEqual(phases, ["paste-intent", "pasted", "submit-intent", "submitted"]);
  // Clearing precedes the durable paste intent; our text is written once.
  assert.deepEqual(manager.events.map((event) => event.args[0]).slice(-3), [
    "load-buffer",
    "paste-buffer",
    "send-keys",
  ]);
  assert.equal(manager.events.filter((event) => event.input === "new message").length, 1);
});

test("an Enter that Claude does not take is reported, never assumed", async () => {
  const model = claudePromptModel({ ignoreEnter: true });
  const manager = claudeModelManager(model);
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(tx.write("kept in prompt", { allowComposerDraft: true }), {
      status: 409,
      code: "CHAT_SUBMIT_UNCONFIRMED",
    });
  });
  assert.deepEqual(model.lines, ["kept in prompt"]);
});

test("a menu opening at the paste intent is closed before the paste", async () => {
  const model = claudePromptModel();
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  const calls = [];
  await chat.withChatInput(manager, "one", (tx) =>
    tx.write("hello", {
      allowComposerDraft: true,
      onPhase: async (phase) => {
        calls.push(phase);
        if (phase === "paste-intent") model.dialog = screens.rewind;
      },
      onRefused: async (phase) => calls.push(`refused:${phase}`),
    }),
  );
  assert.deepEqual(calls, ["paste-intent", "pasted", "submit-intent", "submitted"]);
  assert.deepEqual(model.submitted, ["hello"]);
  assert.deepEqual(model.dialogInput, []);
});

test("a refused intent guard lets the caller restore its last proven phase", async () => {
  const model = claudePromptModel();
  const manager = claudeModelManager(model);
  manager.chatInputTiming = quick;
  const calls = [];
  await chat.withChatInput(manager, "one", async (tx) => {
    await assert.rejects(
      tx.write("hello", {
        allowComposerDraft: true,
        onPhase: async (phase) => {
          calls.push(phase);
          // A permission prompt opens while the intent is being persisted.
          if (phase === "paste-intent") model.dialog = screens.permission;
        },
        onRefused: async (phase) => calls.push(`refused:${phase}`),
      }),
      { code: "CHAT_QUESTION_OPEN" },
    );
  });
  assert.deepEqual(calls, ["paste-intent", "refused:paste-intent"]);
  assert.deepEqual(manager.events, []);
  assert.deepEqual(model.keys, []);
});
