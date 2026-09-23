import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import {
  claudeComposerState,
  clearClaudeComposer,
} from "../../server/features/sessions/claude-composer.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";

// Real Claude Code 2.1.280 frames: narrow and NO_COLOR panes while Claude is
// busy with a queued message, and short panes whose draft hides the bottom border.
const screens = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-screens.json", import.meta.url),
  ),
);
const inspect = ({ raw, pane }) => chat.inspectChatComposer("claude", raw, pane);
const state = (frame) => claudeComposerState(frame.raw, frame.pane, inspect(frame)).state;

test("the queued-message placeholder is empty in narrow and colorless panes", () => {
  for (const name of [
    "idleNarrow30",
    "queueNarrow30",
    "queueNarrow34",
    "idleNoColor",
    "queueNoColor",
  ]) {
    assert.equal(inspect(screens[name]).state, "empty", name);
    assert.equal(state(screens[name]), "empty", name);
  }
  // Without color, a typed draft with its cursor on the first character looks
  // like a placeholder; only Claude's own placeholder text counts as empty.
  const { raw, pane } = screens.queueNoColor;
  const typed = raw.replace(
    /(❯.\x1b\[7mP\x1b\[0m)ress up to edit queued messages/,
    "$1lease run the tests",
  );
  assert.notEqual(typed, raw);
  assert.equal(state({ raw: typed, pane }), "draft");
});

test("a draft clipped by a short pane is still Claude's prompt box", () => {
  assert.equal(state(screens.draftShort60x8), "draft");
  assert.equal(state(screens.draftShort40x10), "draft");
});

test("a pasted draft in a short pane is submitted, then confirmed by the queue placeholder", async () => {
  const model = claudePromptModel();
  const manager = claudeModelManager(model);
  let pasted = false;
  let submitted = false;
  model.screen = () =>
    submitted
      ? screens.queueNarrow30
      : pasted
        ? screens.draftShort60x8
        : screens.idleNarrow30;
  const tmux = manager.tmux;
  manager.tmux = async (args, options) => {
    if (args[0] === "paste-buffer") pasted = true;
    if (args[0] === "send-keys" && args.at(-1) === "Enter") submitted = true;
    return tmux(args, options);
  };
  await chat.withChatInput(manager, "one", (tx) =>
    tx.write("AP_PROBE_D lorem ipsum", { allowComposerDraft: true }),
  );
  assert.equal(submitted, true);
});

test("draft clearing ignores spinner output and is bounded in time and keystrokes", async () => {
  const stuck = claudePromptModel({ draft: "old draft" });
  stuck.key = (name) => stuck.keys.push(name);
  let tick = 0;
  const render = stuck.screen;
  // A running turn redraws its spinner and timer outside the prompt box.
  stuck.screen = () => {
    const frame = render();
    const rows = frame.raw.split("\n");
    rows[2] = `✻ Working… ${tick++}s`;
    return { ...frame, raw: rows.join("\n") };
  };
  const manager = claudeModelManager(stuck);
  const snapshot = async () => {
    const { raw, pane } = stuck.screen();
    return { raw, pane, composer: chat.inspectChatComposer("claude", raw, pane) };
  };
  const started = performance.now();
  await assert.rejects(
    clearClaudeComposer(manager, { id: "one" }, await snapshot(), snapshot, {
      settleMs: 30,
    }),
    { code: "CHAT_COMPOSER_NOT_CLEARED" },
  );
  // One round without progress in the prompt box ends the attempt.
  assert.deepEqual(stuck.keys, ["C-e", "C-u", "BSpace", "DC"]);

  // An endlessly "progressing" prompt stops at the key and time limits.
  const endless = claudePromptModel({ draft: "x".repeat(10) });
  endless.key = (name) => {
    endless.keys.push(name);
    endless.lines = [`${endless.keys.length}`];
    endless.col = endless.lines[0].length;
  };
  const other = claudeModelManager(endless);
  const next = async () => {
    const { raw, pane } = endless.screen();
    return { raw, pane, composer: chat.inspectChatComposer("claude", raw, pane) };
  };
  await assert.rejects(
    clearClaudeComposer(other, { id: "one" }, await next(), next, {
      settleMs: 30,
      maxKeys: 20,
    }),
    { code: "CHAT_COMPOSER_NOT_CLEARED" },
  );
  assert.ok(endless.keys.length <= 20);
  await assert.rejects(
    clearClaudeComposer(other, { id: "one" }, await next(), next, {
      settleMs: 30,
      timeoutMs: 200,
    }),
    { code: "CHAT_COMPOSER_NOT_CLEARED" },
  );
  assert.ok(performance.now() - started < 3000);
});

// Real Claude Code 2.1.280 dialogs in narrow panes (50x34, 50x12). The model
// picker's footer scrolls away there: Enter must still never reach it.
const narrow = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-dialogs-narrow.json", import.meta.url),
  ),
);

test("narrow dialogs are recognized and split into questions and menus", async () => {
  const { claudeQuestion, closableClaudeDialog } =
    await import("../../server/features/sessions/claude-prompt.js");
  for (const [name, question] of [
    ["modelPicker50x34", false],
    ["rewind50x34", false],
    ["permission50x34", true],
    ["question50x34", true],
    ["question50x12", true],
  ]) {
    const frame = { ...narrow[name], composer: inspect(narrow[name]) };
    assert.equal(state(narrow[name]), "dialog", name);
    assert.equal(claudeQuestion(frame), question, name);
    assert.equal(closableClaudeDialog(frame), !question, name);
  }
});

test("a model picker without a visible footer is closed before the message", async () => {
  const model = claudePromptModel({ dialog: narrow.modelPicker50x34 });
  const manager = claudeModelManager(model);
  manager.chatInputTiming = { dialog: { settleMs: 40 } };
  const result = await chat.withChatInput(manager, "one", (tx) =>
    tx.write("hello", { allowComposerDraft: true }),
  );
  assert.deepEqual(model.keys, ["Escape", "Enter"]);
  assert.deepEqual(model.dialogInput, []);
  assert.deepEqual(model.submitted, ["hello"]);
  assert.deepEqual(result.notices, ["CHAT_DIALOG_CLOSED"]);
});

// A permission prompt resized into a short pane: the question scrolls away and
// only options and the footer stay. Escape there would deny the tool call.
const short = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-dialogs-short.json", import.meta.url),
  ),
);

test("short-pane permission prompts stay questions; only titled menus are closable", async () => {
  const { claudeQuestion, closableClaudeDialog } =
    await import("../../server/features/sessions/claude-prompt.js");
  for (const [name, question] of [
    ["permission40x12", true],
    ["permission36x12", true],
    ["permission30x10", true],
    ["rewind40x12", false],
    ["rewind30x10", false],
    ["modelPicker40x12", false],
    ["modelPicker30x10", false],
  ]) {
    const frame = { ...short[name], composer: inspect(short[name]) };
    assert.equal(state(short[name]), "dialog", name);
    assert.equal(claudeQuestion(frame), question, name);
    assert.equal(closableClaudeDialog(frame), !question, name);
  }
  for (const name of ["permission40x12", "permission36x12", "permission30x10"]) {
    const model = claudePromptModel({ dialog: short[name] });
    const manager = claudeModelManager(model);
    manager.chatInputTiming = { dialog: { settleMs: 20, waitMs: 20 } };
    await chat.withChatInput(manager, "one", async (tx) => {
      await assert.rejects(tx.write("hello", { allowComposerDraft: true }), {
        code: "CHAT_QUESTION_OPEN",
      });
    });
    assert.deepEqual(model.keys, [], name);
  }
});

test("a menu footer alone or a stray title row never invites Escape", async () => {
  const { closableClaudeDialog } =
    await import("../../server/features/sessions/claude-prompt.js");
  const pane = { cursorX: 0, cursorY: 4, width: 40, height: 6 };
  const frame = (raw) => ({ raw, pane, composer: inspect({ raw, pane }) });
  // An unknown menu with only an Escape footer waits instead.
  const unknown = frame("Pick a theme\n\n  ❯ Dark\n    Light\n\n Esc to cancel");
  assert.equal(state(unknown), "dialog");
  assert.equal(closableClaudeDialog(unknown), false);
  // Assistant text "Rewind" above a footer is not the rewind panel.
  const stray = frame("Rewind\n\n  ❯ Dark\n    Light\n\n Esc to cancel");
  assert.equal(closableClaudeDialog(stray), false);
});

test("the transcript echo of a message starting with 1. is not a dialog", () => {
  const raw = "❯ 1. first point of my message\n\nSynthetic reply\nWorking…";
  const pane = { cursorX: 0, cursorY: 3, width: 40, height: 4 };
  assert.equal(state({ raw, pane }), "unknown");
});
