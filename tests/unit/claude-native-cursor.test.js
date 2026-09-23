import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectChatComposer } from "../../server/features/sessions/session-chat-input.js";
import {
  claudeComposerState,
  claudePlaceholder,
  clearClaudeComposer,
} from "../../server/features/sessions/claude-composer.js";

// Claude Code draws no cursor cell with its native terminal cursor; AgentPier 1.20.0
// read every such prompt as a draft and refused chat sends it could not clear.
const screens = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-native-cursor.json", import.meta.url),
  ),
);
const state = ({ raw, pane }) =>
  claudeComposerState(raw, pane, inspectChatComposer("claude", raw, pane));

test("a native-cursor prompt with a dim suggestion is empty", () => {
  assert.deepEqual(state(screens.suggestion), { state: "empty", text: "" });
  assert.deepEqual(state(screens.afterClear), { state: "empty", text: "" });
});

test("a native-cursor draft is read as its exact text", () => {
  assert.deepEqual(
    inspectChatComposer("claude", screens.typedDraft.raw, screens.typedDraft.pane),
    {
      state: "text",
      text: "mein entwurf",
    },
  );
  assert.equal(state(screens.wrappedDraft).state, "draft");
});

test("native-cursor placeholders are dim; typed text never counts as a placeholder", () => {
  const pane = { cursorX: 2 };
  assert.equal(
    claudePlaceholder("\x1b[39m❯ \x1b[2mok dann gerne mergen\x1b[0m", pane),
    true,
  );
  assert.equal(
    claudePlaceholder(
      "\x1b[39m❯ \x1b[2m\x1b[39mPress up to edit queued messages\x1b[0m",
      pane,
      {
        queued: true,
      },
    ),
    true,
  );
  assert.equal(
    claudePlaceholder("\x1b[39m❯ \x1b[2mok dann gerne mergen", pane, { queued: true }),
    false,
  );
  assert.equal(
    claudePlaceholder("\x1b[39m❯ Press up to edit queued messages", pane),
    false,
  );
  assert.equal(
    claudePlaceholder("\x1b[39m❯ \x1b[2mok dann gerne mergen\x1b[0m", { cursorX: 5 }),
    false,
  );
});

test("clearing a native-cursor draft stops at the suggestion placeholder", async () => {
  const frames = [screens.typedDraft, screens.afterClear];
  let index = 0;
  const keys = [];
  const snapshot = async () => {
    const { raw, pane } = frames[index];
    return { raw, pane, composer: inspectChatComposer("claude", raw, pane) };
  };
  const manager = {
    target: () => "private",
    tmux: async (args) => {
      keys.push(args.slice(3).join(" "));
      index = Math.min(index + 1, frames.length - 1);
    },
  };
  const fresh = await clearClaudeComposer(
    manager,
    { id: "native" },
    await snapshot(),
    snapshot,
    {
      settleMs: 100,
    },
  );
  assert.equal(state(fresh).state, "empty");
  assert.deepEqual(keys, ["C-e C-u"]);
});
