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
// busy with a queued message.
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
