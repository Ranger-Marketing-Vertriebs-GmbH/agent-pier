import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeShellTracker } from "../../server/features/chat/claude-shells.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { TaskReads } from "../../server/features/chat/task-reads.js";
import { readClaudeSubagent } from "../../server/features/chat/claude-subagent-transcript.js";

const OUTPUT = "/tmp/claude-501/-fixture-project/fixture-session/tasks";
const call = (id) => ({
  type: "assistant",
  timestamp: "2026-11-16T20:00:00.000Z",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `toolu_${id}`,
        name: "Bash",
        input: { command: `sleep ${id}`, run_in_background: true },
      },
    ],
  },
});
const result = (id) => ({
  type: "user",
  timestamp: "2026-11-16T20:00:01.000Z",
  sessionId: "fixture-session",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: `toolu_${id}`,
        content: `Command running in background with ID: ${id}. Output is being written to: ${OUTPUT}/${id}.output.`,
      },
    ],
  },
  toolUseResult: { stdout: "", backgroundTaskId: id },
});

test("the shell tracker keeps at most 100 unanswered launches, dropping the oldest", () => {
  const tracker = claudeShellTracker();
  for (let i = 0; i <= 100; i++) tracker.record(call(`s${i}`));
  tracker.record(result("s0"));
  assert.deepEqual(tracker.snapshot(), []);
  tracker.record(result("s1"));
  tracker.record(result("s100"));
  assert.deepEqual(
    tracker.snapshot().map((shell) => shell.id),
    ["s1", "s100"],
  );
});

test("an output path must start at a claude-<uid> folder", () => {
  const tracker = claudeShellTracker();
  tracker.record(call("a"));
  tracker.record({
    ...result("a"),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_a",
          content:
            "Output is being written to: ../claude-501/p/fixture-session/tasks/a.output.",
        },
      ],
    },
  });
  assert.equal(tracker.snapshot()[0].outputFile, undefined);
});

test("the chat store remembers shell output paths without exposing them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-"));
  const session = { id: "s1", tool: "claude", accountId: "a", status: "running" };
  const store = new ChatStore({
    dataDir: dir,
    sessions: { get: async () => session },
    history: {},
  });
  try {
    const content = {
      messages: [],
      tasks: [],
      observability: {
        shells: [
          {
            id: "b1",
            command: "x",
            status: "running",
            outputFile: `${OUTPUT}/b1.output`,
          },
          { id: "b2", command: "y", status: "running" },
        ],
      },
    };
    const snap = store.snapshot(session, "native", content, true, { persist: false });
    assert.equal(store.shellOutputFile("s1", "b1"), `${OUTPUT}/b1.output`);
    assert.equal(store.shellOutputFile("s1", "b2"), null);
    assert.equal(store.shellOutputFile("other", "b1"), null);
    assert.equal(JSON.stringify(snap).includes("outputFile"), false);
    // A saved snapshot without paths keeps the known ones; a vanished shell drops its.
    store.snapshot(
      session,
      "native",
      { ...content, observability: { shells: [{ id: "b1", command: "x" }] } },
      true,
      { persist: false },
    );
    assert.equal(store.shellOutputFile("s1", "b1"), `${OUTPUT}/b1.output`);
    store.snapshot(
      session,
      "native",
      { ...content, observability: { shells: [] } },
      true,
      {
        persist: false,
      },
    );
    assert.equal(store.shellOutputFile("s1", "b1"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the read flags depend on the tool and the known output file", () => {
  const reads = new TaskReads({
    chat: { shellOutputFile: (_id, shell) => (shell === "b1" ? "/x" : null) },
  });
  assert.deepEqual(reads.flags({ tool: "claude" }, "subagent", {}), {
    hasTranscript: true,
  });
  assert.deepEqual(reads.flags({ tool: "shell" }, "subagent", {}), {
    hasTranscript: false,
  });
  assert.deepEqual(reads.flags({ id: "s" }, "shell", { id: "b1" }), { hasOutput: true });
  assert.deepEqual(reads.flags({ id: "s" }, "shell", { id: "b2" }), { hasOutput: false });
});

test("a subagent file keeps its own sidechain records and drops request records", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-sub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "native", "subagents");
  fs.mkdirSync(folder, { recursive: true });
  const text = fs.readFileSync(
    new URL("../fixtures/observability/claude-subagent-file.jsonl", import.meta.url),
    "utf8",
  );
  const other = JSON.stringify({
    type: "user",
    isSidechain: true,
    agentId: "someoneelse",
    uuid: "x1",
    message: { role: "user", content: "FOREIGN" },
  });
  fs.writeFileSync(
    path.join(folder, "agent-ad8fe347eb34a68b1.jsonl"),
    text + other + "\n",
  );
  const history = { claudeFile: async () => path.join(root, "native.jsonl") };
  const content = await readClaudeSubagent(history, {}, "native", "ad8fe347eb34a68b1");
  assert.ok(content.messages.length > 0);
  assert.equal(JSON.stringify(content).includes("FOREIGN"), false);
  await assert.rejects(readClaudeSubagent(history, {}, "native", "../x"), {
    status: 400,
  });
});
