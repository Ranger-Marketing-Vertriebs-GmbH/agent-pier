import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";
import { readHistoryPage } from "../../server/features/chat/history-page.js";

// Shapes from openai/codex@rust-v0.159.2 for a TUI `!cmd` (thread/shellCommand):
// thread/turns/list returns a v2 commandExecution item with source "userShell" and a
// shlex-joined command; a paginated rollout stores the core TurnItem as item_completed
// with source "user_shell" and the argv array. Neither has a user message.
const uuid7 = (ms) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7abc-8def-0123456789ab`;
};
const now = Date.parse("2026-10-16T08:00:00.000Z");
const indexed = uuid7(now + 1);
const resumed = uuid7(now + 2);
const apiItem = {
  type: "commandExecution",
  id: "api-shell",
  command: "/bin/zsh -lc 'git status --short'",
  cwd: "/project",
  processId: null,
  source: "userShell",
  status: "completed",
  commandActions: [],
  aggregatedOutput: " M a.js\n",
  exitCode: 0,
  durationMs: 8,
};
const event = (turn, type, extra = {}) => ({
  type: "event_msg",
  payload: { type, turn_id: turn, ...extra },
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-user-shell-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const session = { tool: "codex", cwd: root };
  const turns = [{ id: indexed, status: "completed", items: [apiItem] }];
  const history = {
    environment: () => ({ CODEX_HOME: root }),
    codexRolloutIdentity: ProviderHistory.prototype.codexRolloutIdentity,
    codexRequest: async (_session, run) =>
      run({
        request: async (method, params) =>
          method === "thread/read"
            ? {
                thread: {
                  id: "thread",
                  cwd: root,
                  path: file,
                  ...(params.includeTurns && { turns }),
                },
              }
            : { data: [...turns].reverse(), nextCursor: null },
      }),
  };
  await fs.writeFile(
    file,
    [
      { type: "session_meta", payload: { id: "thread", cwd: root } },
      event(indexed, "task_started"),
      event(resumed, "task_started"),
      event(resumed, "item_completed", {
        thread_id: "thread",
        item: {
          type: "CommandExecution",
          id: "tail-shell",
          command: ["/bin/zsh", "-lc", "echo 'two words'"],
          cwd: root,
          parsed_cmd: [],
          source: "user_shell",
          status: "failed",
          stdout: "",
          stderr: "boom",
          aggregated_output: "boom",
          exit_code: 2,
          duration: { secs: 0, nanos: 5000000 },
          formatted_output: "boom",
        },
        started_at_ms: now + 3,
        completed_at_ms: now + 4,
      }),
      event(resumed, "task_complete"),
    ]
      .map((record) => JSON.stringify(record) + "\n")
      .join(""),
  );
  return { root, session, history, turns };
}

test("Codex history pages show user shell commands from the API and the rollout tail", async (t) => {
  const x = await fixture(t);
  const page = await readHistoryPage(x.history, x.session, "thread");
  assert.deepEqual(
    page.messages.map((m) => [m.role, m.text, m.status, m.shellOutput]),
    [
      ["user", "! git status --short", undefined, undefined],
      ["tool", JSON.stringify({ output: " M a.js" }), "completed", true],
      ["user", "! echo 'two words'", undefined, undefined],
      ["tool", JSON.stringify({ output: "boom" }), "failed", true],
    ],
  );
  assert.deepEqual(
    page.messages.filter((m) => m.role === "user").map((m) => m.timestamp),
    [now + 1, now + 2],
  );
  assert.equal(new Set(page.messages.map((m) => m.id)).size, 4);
});

test("a full Codex read shows the indexed user shell command like a page", async (t) => {
  const x = await fixture(t);
  const history = Object.assign(Object.create(ProviderHistory.prototype), x.history, {
    codexChildren: { read: async () => null },
  });
  const full = await history.read(x.session, "thread");
  const page = await readHistoryPage(x.history, x.session, "thread");
  // The resumed turn exists only in the rollout tail, which full reads do not merge.
  assert.deepEqual(full.messages, page.messages.slice(0, 2));
});

test('a rollout argv that is not [shell, "-lc", cmd] stays a command row', async (t) => {
  const x = await fixture(t);
  const file = path.join(x.root, "rollout.jsonl");
  const records = (await fs.readFile(file, "utf8")).replace(
    JSON.stringify(["/bin/zsh", "-lc", "echo 'two words'"]),
    JSON.stringify(["/bin/zsh", "-c", "echo 'two words'"]),
  );
  await fs.writeFile(file, records);
  const page = await readHistoryPage(x.history, x.session, "thread");
  const tail = page.messages.filter((m) => m.id.startsWith("tail-shell"));
  assert.deepEqual(
    tail.map((m) => [m.id, m.role, m.toolName, m.shellOutput, m.status]),
    [["tail-shell", "tool", "Command", undefined, "failed"]],
  );
});
