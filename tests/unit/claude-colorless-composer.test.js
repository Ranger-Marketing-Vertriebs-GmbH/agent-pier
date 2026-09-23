import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectChatComposer } from "../../server/features/sessions/session-chat-input.js";
import {
  claudeComposerState,
  colorlessScreen,
  confirmClaudeSubmit,
} from "../../server/features/sessions/claude-composer.js";
import {
  awaitClaudePaste,
  prepareClaudePrompt,
} from "../../server/features/sessions/claude-prompt.js";
import { nativeInputQueue } from "../../server/features/chat/native-input-queue.js";

// Real Claude Code 2.1.280 frames with default colors, NO_COLOR=1 and
// FORCE_COLOR=0, with Claude's cursor cell and with the native terminal cursor
// (CLAUDE_CODE_NATIVE_CURSOR=1). Without color, Claude emits only the
// reverse-video cursor cell, and nothing at all with the native cursor.
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
  const claude = claudeComposerState(raw, pane, composer);
  return {
    state: composer.state,
    text: composer.text,
    claude: claude.state + (claude.placeholder ? "?" : ""),
  };
};
const text = (value) => ({ state: "text", text: value, claude: "text" });
const unreadable = (claude = "draft") => ({ state: "unknown", text: null, claude });
const empty = { state: "empty", text: "", claude: "empty" };
const expected = {
  idle: empty,
  single: text("hello draft"),
  placeholderTextEnd: text("Press up to edit queued messages"),
  fit: text("x".repeat(76)),
  spaces: text("two  spaces "),
  // Cursor mid-line or at the start, several rows, bash mode and pasted-text
  // summaries are prompt boxes whose exact text cannot be read.
  midline: unreadable(),
  start: unreadable(),
  placeholderText: unreadable(),
  multiline: unreadable(),
  wrapped: unreadable(),
  bash: unreadable(),
  bashEmpty: unreadable(),
  pasted: unreadable(),
};
// Without color a row with its cursor on the first character may also be a
// placeholder ("draft?"): only the prompt's reaction to editing keys decides.
const colorless = { ...expected, start: unreadable("draft?") };
colorless.placeholderText = unreadable("draft?");
// tmux drops the trailing blank that only the cursor cell shows.
const native = { ...expected, spaces: unreadable() };
const nativeColorless = { ...colorless, spaces: unreadable() };
const variants = {
  color80: expected,
  noColor80: colorless,
  forceColor0x80: colorless,
  nativeColor80: native,
  nativeNoColor80: nativeColorless,
  nativeForceColor0x80: nativeColorless,
};

test("colorless screens are recognized by their styling alone", () => {
  for (const pane of Object.keys(variants))
    for (const [name, frame] of Object.entries(frames[pane]))
      assert.equal(
        colorlessScreen(frame.raw),
        /noColor|forceColor0/i.test(pane),
        `${pane}.${name}`,
      );
});

test("colorless Claude drafts read like colored ones in both cursor modes", () => {
  for (const [pane, table] of Object.entries(variants)) {
    assert.deepEqual(Object.keys(frames[pane]).sort(), Object.keys(table).sort());
    for (const [name, frame] of Object.entries(frames[pane]))
      assert.deepEqual(read(frame), table[name], `${pane}.${name}`);
  }
});

test("a colorless draft typed during a turn is read exactly", () => {
  for (const pane of [
    "busyNoColor80",
    "busyNoColorAcceptEdits80",
    "busyNoColor34",
    "busyNativeNoColor80",
    "busyNativeForceColor0x24",
  ])
    assert.deepEqual(read(frames[pane].busyDraft), text("busy draft"), pane);
  assert.deepEqual(read(frames.busyColor80.busyDraftStart), unreadable());
  for (const pane of ["busyNoColor80", "busyNativeNoColor80", "busyForceColor0x24"])
    assert.deepEqual(read(frames[pane].busyDraftStart), unreadable("draft?"), pane);
});

test("typed placeholder text is never taken for an empty prompt", () => {
  // Without color, "Press up to edit queued messages" with the cursor on its
  // first character is byte-identical to Claude's queued placeholder.
  const typed = [
    ["color80", "placeholderText"],
    ["nativeColor80", "placeholderText"],
    ["busyColor80", "queueTypedStart"],
  ];
  for (const pane of Object.keys(frames))
    if (/^busy.*(No|Force)Color/.test(pane) && frames[pane].queueTypedStart)
      typed.push([pane, "queueTypedStart"]);
  for (const pane of ["noColor80", "forceColor0x80", "nativeNoColor80"])
    typed.push([pane, "placeholderText"]);
  for (const [pane, name] of typed) {
    const frame = frames[pane][name];
    assert.notEqual(read(frame).claude, "empty", `${pane}.${name}`);
    assert.notEqual(read(frame).state, "empty", `${pane}.${name}`);
    assert.deepEqual(nativeInputQueue("claude", frame.raw, frame.pane), []);
  }
  for (const pane of ["busyNoColor80", "busyNativeNoColor80"]) {
    const row = (frame) => frame.raw.split("\n")[frame.pane.cursorY];
    assert.equal(row(frames[pane].queueTypedStart), row(frames[pane].queue), pane);
  }
});

test("the colorless queued placeholder needs Claude's empty-prompt footer", () => {
  for (const pane of [
    "busyColor80",
    "busyNoColor80",
    "busyNoColorAcceptEdits80",
    "busyNoColor34",
    "busyNoColor40",
    "busyNativeNoColor80",
    "busyNativeForceColor0x40",
  ])
    assert.deepEqual(read(frames[pane].queue), empty, pane);
  // At 24 columns the footer hint is cut to "…": a placeholder-shaped draft.
  for (const pane of ["busyForceColor0x24", "busyNativeForceColor0x24"])
    assert.deepEqual(read(frames[pane].queue), unreadable("draft?"), pane);
  const { raw, pane } = frames.busyNoColor80.queue;
  const withFooter = (footer) => {
    const rows = raw.split("\n");
    rows[pane.cursorY + 2] = footer;
    return read({ raw: rows.join("\n"), pane }).claude;
  };
  // A right-aligned notice after the hint in the same row keeps it readable.
  for (const footer of [
    "  ⏸ manual mode on · esc to interrupt            ◯ IDE connected",
    "  ⏸ manual mode on · ? for shortcuts   ◯ IDE connected",
  ])
    assert.equal(withFooter(footer), "empty", footer);
  // A longer segment that merely contains a hint does not count.
  for (const footer of [
    "  ⏸ manual mode on · press ? for shortcuts later",
    "  ⏸ manual mode on · not esc to interrupt",
    "  ⏸ manual mode on            ◯ esc to interrupting",
    "  ⏸ manual mode on",
    "  ⏸ manual mode on · esc to…",
    "",
  ])
    assert.equal(withFooter(footer), "draft?", footer);
});

/** A pane that shows `frames[i]` and advances on every key in `moves`. */
function pane(sequence, moves = sequence.length - 1) {
  let index = 0;
  const keys = [];
  const snapshot = async () => {
    const { raw, pane } = sequence[index];
    return { raw, pane, composer: inspectChatComposer("claude", raw, pane) };
  };
  const manager = {
    target: () => "private",
    tmux: async (args) => {
      keys.push(args.slice(3).join(" "));
      if (keys.length <= moves) index = Math.min(index + 1, sequence.length - 1);
    },
  };
  return { snapshot, manager, keys };
}
const timing = { clear: { settleMs: 30 }, dialog: { waitMs: 0 } };

test("a colorless placeholder that ignores editing keys is an empty prompt", async () => {
  for (const name of ["busyForceColor0x24", "busyNativeForceColor0x24"]) {
    const { snapshot, manager, keys } = pane([frames[name].queue], 0);
    const result = await prepareClaudePrompt(
      manager,
      { id: "one" },
      await snapshot(),
      snapshot,
      timing,
    );
    assert.equal(result.appended, false, name);
    assert.deepEqual(keys, ["C-e C-u", "BSpace", "DC"], name);
  }
});

test("a colorless draft with its cursor at the start is replaced", async () => {
  for (const name of ["noColor80", "nativeNoColor80"]) {
    const { start, idle } = frames[name];
    const { snapshot, manager, keys } = pane([start, idle]);
    const result = await prepareClaudePrompt(
      manager,
      { id: "one" },
      await snapshot(),
      snapshot,
      timing,
    );
    assert.equal(result.appended, false, name);
    assert.equal(read(result.fresh).claude, "empty", name);
    assert.deepEqual(keys, ["C-e C-u"], name);
  }
});

test("a placeholder-shaped colorless row never proves a paste but confirms Enter", async () => {
  const queue = frames.busyForceColor0x24.queue;
  const { snapshot } = pane([queue]);
  await assert.rejects(
    awaitClaudePaste(snapshot, async () => {}, { timeoutMs: 60, unknownMs: 30 }),
    { code: "CHAT_SUBMIT_UNCONFIRMED" },
  );
  await confirmClaudeSubmit(snapshot, { timeoutMs: 60 });
  const typed = pane([frames.busyForceColor0x24.busyDraft]);
  await assert.rejects(confirmClaudeSubmit(typed.snapshot, { timeoutMs: 60 }), {
    code: "CHAT_SUBMIT_UNCONFIRMED",
  });
});

test("a colorless prompt suggestion is empty only with the empty-prompt footer", () => {
  for (const [name, frame] of Object.entries(frames.suggestionNoColor80)) {
    assert.deepEqual(read(frame), empty, name);
    const rows = frame.raw.split("\n");
    rows[frame.pane.cursorY + 2] = "  ⏸ manual mode on";
    assert.deepEqual(
      read({ raw: rows.join("\n"), pane: frame.pane }),
      unreadable("draft?"),
    );
  }
});
