import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { nativeLimitWarnings } from "../../server/features/chat/native-limit-warnings.js";
const frames = JSON.parse(
  fs.readFileSync(new URL("../fixtures/native-input-queue.json", import.meta.url)),
);
const codex =
  "Heads up, you have less than 10% of your weekly limit left. Run /status for a breakdown.";
const claude = "You've used 90% of your weekly limit · resets Oct 4 at 12pm";
function codexFrame(text) {
  const { raw, pane } = frames.codex.snapshots.idle;
  const lines = raw.split("\n");
  lines.splice(0, 3, ...text.split("\n"));
  return {
    raw: lines.join("\n"),
    pane: { ...pane, cursorY: pane.cursorY - 3 + text.split("\n").length },
  };
}
function read(tool, frame) {
  return nativeLimitWarnings(tool, frame.raw, frame.pane);
}
function claudeFrame(text, draft = "") {
  const border = "─".repeat(100);
  return {
    raw: [
      claude,
      border,
      "❯ " + draft,
      border,
      "  ? for shortcuts",
      "  " + text,
      "",
    ].join("\n"),
    pane: { width: 100, height: 8, cursorX: 2, cursorY: 2 },
  };
}
test("Codex mirrors only complete styled native warning cells and deduplicates redraws", () => {
  const line = "\x1b[38;5;3m⚠ " + codex + "\x1b[39m";
  assert.deepEqual(read("codex", codexFrame(line)), [codex]);
  assert.deepEqual(read("codex", codexFrame(line + "\n" + line)), [codex]);
  assert.deepEqual(
    read("codex", codexFrame(line.replace("weekly limit", "weekly\n  limit"))),
    [codex],
  );
  for (const text of [
    codex,
    "⚠ " + codex,
    "• " + line,
    line.replace("breakdown.", "break…"),
    line.replace("Heads up", "Some other warning"),
  ])
    assert.deepEqual(read("codex", codexFrame(text)), []);
  assert.deepEqual(read("codex", frames.codex.snapshots.idle), []);
});
test("Claude recognizes native warning variants only below the composer", () => {
  for (const text of [
    claude,
    "Approaching session limit · resets 3pm",
    "You're close to your usage credit limit",
    "Approaching your 5-hour usage limit — Claude will wrap up the current step.",
  ])
    assert.deepEqual(read("claude", claudeFrame(text)), [text]);
  assert.deepEqual(read("claude", claudeFrame("", claude)), []);
  assert.deepEqual(read("claude", claudeFrame("A discussion of " + claude)), []);
  assert.deepEqual(
    read(
      "claude",
      claudeFrame("You've used 90% of your\n  weekly limit · resets Oct 4 at 12pm"),
    ),
    [claude],
  );
  assert.deepEqual(read("claude", claudeFrame("Unrelated notification")), []);
  const frame = claudeFrame(claude);
  assert.deepEqual(read("claude", { ...frame, pane: { ...frame.pane, height: 3 } }), []);
});
test("unsupported tools, malformed screens and missing composer evidence stay silent", () => {
  const frame = claudeFrame(claude);
  for (const tool of ["shell", "opencode", undefined])
    assert.deepEqual(read(tool, frame), []);
  assert.deepEqual(nativeLimitWarnings("claude", frame.raw, null), []);
  assert.deepEqual(
    nativeLimitWarnings("claude", frame.raw, { ...frame.pane, cursorY: 50 }),
    [],
  );
  assert.deepEqual(nativeLimitWarnings("claude", "x".repeat(300000), frame.pane), []);
  assert.deepEqual(read("claude", { ...frame, raw: claude }), []);
});
