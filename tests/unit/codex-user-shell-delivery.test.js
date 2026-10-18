import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodex } from "../../server/features/chat/history-parsers.js";
import { deliveryMatches, deliveryNotices } from "../../web/features/chat/chat-draft.js";
import { deliveryContentMatches } from "../../web/features/chat/delivery-content.js";
import { TOOL_TEXT_LIMIT } from "../../server/features/chat/tool-text.js";

// Codex 0.159.2 runs a TUI `!cmd` through `thread/shellCommand` (Op::RunUserShellCommand)
// in its own turn; it records no user message. The app-server item is a
// commandExecution with `source: "userShell"` whose `command` is shlex 1.3's join of
// [shell, "-lc", cmd] (codex-rs/core/src/tasks/user_shell.rs, item_builders.rs).
const now = Date.parse("2026-10-16T08:00:00.000Z");
const uuid7 = (ms) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7abc-8def-0123456789ab`;
};
const turnId = uuid7(now + 5);
const shell = (command, extra = {}) => ({
  type: "commandExecution",
  id: "5f0c6a8e-3d2b-4c1a-9e7f-2a4b6c8d0e1f",
  command,
  cwd: "/Users/me/project",
  processId: null,
  source: "userShell",
  status: "completed",
  commandActions: [],
  aggregatedOutput: "a.txt\nb.txt\n",
  exitCode: 0,
  durationMs: 12,
  ...extra,
});
const thread = (...items) => ({ turns: [{ id: turnId, status: "completed", items }] });
const rows = (...items) => normalizeCodex(thread(...items)).messages;
const item = (text) => ({
  id: "delivery",
  text,
  status: "handed-off",
  baselineIds: [],
  clientCreatedAt: new Date(now).toISOString(),
  observation: { startedAt: now },
});

test("a Codex user shell command shows as the typed `! command` plus shell output", () => {
  const messages = rows(shell("/bin/zsh -lc 'cd ~/x && ls -la'"));
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ["user", "! cd ~/x && ls -la"],
      ["tool", JSON.stringify({ output: "a.txt\nb.txt" })],
    ],
  );
  const [input, output] = messages;
  assert.equal(input.timestamp, now + 5);
  assert.notEqual(input.id, output.id);
  assert.equal(output.shellOutput, true);
  assert.equal(output.status, "completed");
  assert.equal(output.shellOmitted, undefined);
});

test("shlex chunks from Codex are unquoted to the exact command", () => {
  const cases = [
    ["/bin/zsh -lc ls", "ls"],
    [`/bin/bash -lc "echo \\"it's\\""`, `echo "it's"`],
    [`/bin/zsh -lc 'echo '"'"'$x'"'"`, "echo '$x'"],
    [`/bin/zsh -lc "printf 'a\\\\n'"`, "printf 'a\\n'"],
    ["/bin/zsh -lc 'echo a\necho b'", "echo a\necho b"],
    ["'/Users/me/my shell/zsh' -lc 'echo ä'", "echo ä"],
  ];
  for (const [command, expected] of cases)
    assert.equal(rows(shell(command))[0].text, `! ${expected}`, command);
});

for (const sent of ["! cd ~/x && ls -la", "!cd ~/x && ls -la", " !  cd ~/x && ls -la"]) {
  test(`Codex shell message ${JSON.stringify(sent.slice(0, 4))} is confirmed`, () => {
    const messages = rows(shell("/bin/zsh -lc 'cd ~/x && ls -la'"));
    const delivery = item(sent);
    assert.equal(deliveryContentMatches(delivery, messages[0], true), true);
    assert.equal(deliveryMatches([delivery], messages).get("delivery"), messages[0].id);
    assert.deepEqual(deliveryNotices({ recent: [delivery], outbox: null }, messages), []);
  });
}

test("agent commands and unrecognised user shell shapes stay command rows", () => {
  for (const command of [
    "/bin/zsh -lc ls",
    "<command included NUL byte>",
    "/bin/zsh -lc 'unclosed",
    "pwsh -Command ls",
  ]) {
    const source = command === "/bin/zsh -lc ls" ? "agent" : "userShell";
    const messages = rows(shell(command, { source }));
    assert.deepEqual(
      messages.map((m) => [m.role, m.toolName, m.shellOutput]),
      [["tool", "Command", undefined]],
      command,
    );
  }
});

test("running and failed user shell commands keep their status", () => {
  const running = rows(
    shell("/bin/zsh -lc ls", {
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    }),
  );
  assert.deepEqual(
    running.map((m) => [m.role, m.text, m.status]),
    [
      ["user", "! ls", undefined],
      ["tool", "", "running"],
    ],
  );
  const failed = rows(shell("/bin/zsh -lc false", { status: "failed", exitCode: 1 }));
  assert.equal(failed[1].status, "failed");
  const statuses = ["in_progress", "inProgress", "completed", "declined"];
  assert.deepEqual(
    statuses.map((status) => rows(shell("/bin/zsh -lc ls", { status }))[1].status),
    ["running", "running", "completed", "failed"],
  );
  for (const status of ["interrupted", "unknown", undefined, 7]) {
    const [, row] = rows(shell("/bin/zsh -lc ls", { status, exitCode: null }));
    assert.equal("status" in row, false, String(status));
  }
});

test("long Codex shell output keeps its tail within one tool payload", () => {
  const output = Array.from({ length: 4000 }, (_, i) => `line "${i}"`).join("\n");
  const [, row] = rows(shell("/bin/zsh -lc ls", { aggregatedOutput: output }));
  assert.ok(row.text.length <= TOOL_TEXT_LIMIT, `${row.text.length} chars`);
  const shown = JSON.parse(row.text).output;
  assert.ok(output.endsWith(shown) && shown.endsWith('line "3999"'));
  assert.deepEqual(row.shellOmitted, {
    output: Buffer.byteLength(output) - Buffer.byteLength(shown),
  });
});

test("user shell command parsing scales linearly on hostile commands", () => {
  // About 1 MB per shape. Linear parsing takes milliseconds; a quadratic one would need
  // on the order of 10^12 steps for these inputs, hours on any host. So one generous
  // bound tells them apart without comparing timings, however busy the host is.
  const shapes = [
    (n) => `/bin/zsh -lc ${"'a'".repeat(n / 3)}`,
    (n) => `/bin/zsh -lc "${"\\".repeat(n / 2)}"`,
    (n) => `/bin/zsh -lc ${'"'.repeat(n + 1)}`,
    (n) => `${" ".repeat(n)}x`,
  ];
  for (const shape of shapes) {
    const started = performance.now();
    rows(shell(shape(1200000)));
    const took = performance.now() - started;
    assert.ok(took < 30000, `${shape(12).slice(0, 20)} took ${Math.round(took)} ms`);
  }
});
