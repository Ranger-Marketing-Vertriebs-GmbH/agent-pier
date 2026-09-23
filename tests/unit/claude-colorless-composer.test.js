import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectChatComposer } from "../../server/features/sessions/session-chat-input.js";
import {
  claudeComposerState,
  colorlessScreen,
} from "../../server/features/sessions/claude-composer.js";
import { nativeInputQueue } from "../../server/features/chat/native-input-queue.js";

// Real Claude Code 2.1.280 frames with default colors, NO_COLOR=1 and
// FORCE_COLOR=0. Without color, Claude emits only the reverse-video cursor cell.
const frames = JSON.parse(
  fs.readFileSync(
    new URL(
      "../fixtures/tui-input/claude-2.1.280-colorless-drafts.json",
      import.meta.url,
    ),
  ),
);
const read = ({ raw, pane }) => {
  const composer = inspectChatComposer("claude", raw, pane);
  return {
    state: composer.state,
    text: composer.text,
    claude: claudeComposerState(raw, pane, composer).state,
  };
};
const expected = {
  idle: { state: "empty", text: "", claude: "empty" },
  single: { state: "text", text: "hello draft", claude: "text" },
  placeholderTextEnd: {
    state: "text",
    text: "Press up to edit queued messages",
    claude: "text",
  },
  fit: { state: "text", text: "x".repeat(76), claude: "text" },
  spaces: { state: "text", text: "two  spaces ", claude: "text" },
};
// Cursor mid-line or at the start, several rows, bash mode and pasted-text
// summaries are prompt boxes whose exact text cannot be read.
for (const name of [
  "midline",
  "start",
  "placeholderText",
  "multiline",
  "wrapped",
  "bash",
  "bashEmpty",
  "pasted",
])
  expected[name] = { state: "unknown", text: null, claude: "draft" };

test("colorless screens are recognized by their styling alone", () => {
  for (const pane of ["noColor80", "forceColor0x80"])
    for (const [name, frame] of Object.entries(frames[pane]))
      assert.equal(colorlessScreen(frame.raw), true, `${pane}.${name}`);
  for (const [name, frame] of Object.entries(frames.color80))
    assert.equal(colorlessScreen(frame.raw), false, name);
});

test("colorless Claude drafts read exactly like colored ones", () => {
  for (const pane of ["color80", "noColor80", "forceColor0x80"]) {
    assert.deepEqual(Object.keys(frames[pane]).sort(), Object.keys(expected).sort());
    for (const [name, frame] of Object.entries(frames[pane]))
      assert.deepEqual(read(frame), expected[name], `${pane}.${name}`);
  }
});

test("a colorless draft typed during a turn is read exactly", () => {
  for (const pane of ["busyNoColor80", "busyNoColorAcceptEdits80", "busyNoColor34"])
    assert.deepEqual(read(frames[pane].busyDraft), {
      state: "text",
      text: "busy draft",
      claude: "text",
    });
  // Cursor on the first character: unreadable, never empty.
  for (const pane of ["busyColor80", "busyNoColor80", "busyForceColor0x24"])
    assert.deepEqual(read(frames[pane].busyDraftStart), {
      state: "unknown",
      text: null,
      claude: "draft",
    });
});

test("typed placeholder text is never taken for an empty prompt", () => {
  // Without color, "Press up to edit queued messages" with the cursor on its
  // first character is byte-identical to Claude's queued placeholder.
  const typed = [
    ["color80", "placeholderText"],
    ["noColor80", "placeholderText"],
    ["forceColor0x80", "placeholderText"],
    ["busyColor80", "queueTypedStart"],
    ["busyNoColor80", "queueTypedStart"],
    ["busyNoColorAcceptEdits80", "queueTypedStart"],
    ["busyNoColor34", "queueTypedStart"],
    ["busyNoColor40", "queueTypedStart"],
    ["busyForceColor0x24", "queueTypedStart"],
  ];
  for (const [pane, name] of typed) {
    const frame = frames[pane][name];
    assert.notEqual(read(frame).claude, "empty", `${pane}.${name}`);
    assert.notEqual(read(frame).state, "empty", `${pane}.${name}`);
    assert.deepEqual(nativeInputQueue("claude", frame.raw, frame.pane), []);
  }
  const placeholder = frames.busyNoColor80.queue.raw.split("\n")[21];
  assert.equal(frames.busyNoColor80.queueTypedStart.raw.split("\n")[21], placeholder);
});

test("the colorless queued placeholder needs Claude's empty-prompt footer", () => {
  for (const pane of [
    "busyColor80",
    "busyNoColor80",
    "busyNoColorAcceptEdits80",
    "busyNoColor34",
    "busyNoColor40",
  ])
    assert.deepEqual(read(frames[pane].queue), {
      state: "empty",
      text: "",
      claude: "empty",
    });
  // At 24 columns the footer hint is cut to "…": this stays an unreadable draft.
  assert.deepEqual(read(frames.busyForceColor0x24.queue), {
    state: "unknown",
    text: null,
    claude: "draft",
  });
  const { raw, pane } = frames.busyNoColor80.queue;
  for (const footer of ["  ⏸ manual mode on", "  ⏸ manual mode on · esc to…", ""]) {
    const rows = raw.split("\n");
    rows[pane.cursorY + 2] = footer;
    assert.notEqual(read({ raw: rows.join("\n"), pane }).claude, "empty", footer);
  }
});
