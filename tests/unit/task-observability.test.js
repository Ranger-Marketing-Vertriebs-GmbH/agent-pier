import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  observeClaude,
  observeCodex,
  observeOpenCode,
  finalizeObservability,
} from "../../server/features/chat/chat-observability.js";
import { settleStatus } from "../../server/features/chat/claude-subagents.js";
import { putShell } from "../../server/features/chat/observability-values.js";
import { claudeShellTracker } from "../../server/features/chat/claude-shells.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/observability/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const OUTPUT = "/tmp/claude-501/-fixture-project/fixture-session/tasks";
const bashCall = (id, command, extra = {}) => ({
  type: "assistant",
  timestamp: "2026-11-16T20:00:00.000Z",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `toolu_${id}`,
        name: "Bash",
        input: { command, description: `Run ${command}`, run_in_background: true },
      },
    ],
  },
  ...extra,
});
const bashResult = (id, outputPath = `${OUTPUT}/${id}.output`) => ({
  type: "user",
  timestamp: "2026-11-16T20:00:01.000Z",
  sessionId: "fixture-session",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: `toolu_${id}`,
        content: `Command running in background with ID: ${id}. Output is being written to: ${outputPath}. You will be notified.`,
      },
    ],
  },
  toolUseResult: { stdout: "", backgroundTaskId: id },
});
const notification = (id, status, summary = "Background command finished") => ({
  type: "user",
  timestamp: "2026-11-16T20:05:00.000Z",
  origin: { kind: "task-notification" },
  message: {
    role: "user",
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  },
});

test("Claude background shells, a killed agent, and aborted or interrupted tasks read as stopped", () => {
  const claude = observeClaude(fixture("claude-shells"));
  assert.deepEqual(
    claude.shells.map((s) => [s.id, s.command, s.description, s.status]),
    [
      ["biedr05v9", "sleep 300", "Sleep for 300 seconds in background", "running"],
      ["b4qyjbxhd", "sleep 400", "Sleep for 400 seconds in background", "running"],
    ],
  );
  assert.match(claude.shells[0].outputFile, /\/tasks\/biedr05v9\.output$/);
  assert.equal(
    claude.subagents.find((a) => a.id === "ad8fe347eb34a68b1").status,
    "stopped",
  );
  assert.equal(
    observeOpenCode(fixture("opencode-aborted")).subagents[0].status,
    "stopped",
  );
  assert.equal(
    observeCodex({}, fixture("codex-interrupted")).subagents[0].status,
    "stopped",
  );
  const activity = observeCodex({}, [
    {
      type: "event_msg",
      timestamp: "2026-09-07T10:00:04Z",
      payload: {
        type: "sub_agent_activity",
        agent_thread_id: "native-agent-two",
        kind: "interrupted",
      },
    },
  ]);
  assert.equal(activity.subagents[0].status, "stopped");
});

test("stopped and unknown never replace a reported completion or failure", () => {
  assert.equal(settleStatus("completed", "stopped"), "completed");
  assert.equal(settleStatus("failed", "stopped"), "failed");
  assert.equal(settleStatus("completed", "unknown"), "completed");
  assert.equal(settleStatus("running", "stopped"), "stopped");
  assert.equal(settleStatus("stopped", "completed"), "completed");
});

test("finalizeObservability normalizes shells and adds the control fields", () => {
  const out = finalizeObservability(
    {
      subagents: [{ id: "a1", status: "running" }],
      shells: [
        { id: "s1", command: "x".repeat(1500), status: "running", outputFile: "/tmp/x" },
      ],
    },
    { status: "running" },
  );
  assert.equal(out.shells[0].command.length, 1000);
  assert.equal("outputFile" in out.shells[0], false);
  assert.deepEqual(
    [
      out.subagents[0].canStop,
      out.subagents[0].hasTranscript,
      out.shells[0].canStop,
      out.shells[0].hasOutput,
      out.stopNotes,
    ],
    [false, false, false, false, []],
  );
  assert.equal(
    finalizeObservability(
      { shells: [{ id: "s1", status: "running" }] },
      { status: "stopped" },
    ).shells[0].status,
    "unknown",
  );
  assert.deepEqual(finalizeObservability(null, { status: "running" }).shells, []);
});

test("a Claude shell ends by notification or TaskStop and keeps a finished state", () => {
  const states = (records) =>
    Object.fromEntries(observeClaude(records).shells.map((s) => [s.id, s]));
  const base = [bashCall("one", "sleep 1"), bashResult("one")];
  assert.equal(
    states([...base, notification("one", "completed", "done (exit code 0)")]).one.status,
    "completed",
  );
  assert.equal(
    states([...base, notification("one", "completed", "done (exit code 0)")]).one
      .exitCode,
    0,
  );
  assert.equal(states([...base, notification("one", "failed")]).one.status, "failed");
  assert.equal(states([...base, notification("one", "killed")]).one.status, "stopped");
  assert.equal(
    states([...base, notification("one", "completed"), notification("one", "killed")]).one
      .status,
    "completed",
  );
  const stop = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s" }] },
    toolUseResult: { task_type: "local_bash", task_id: "one", message: "Stopped" },
  };
  assert.equal(states([...base, stop]).one.status, "stopped");
  // A notification naming no known shell creates nothing.
  assert.deepEqual(observeClaude([notification("ghost", "completed")]).shells, []);
});

test("only main-loop background Bash calls become shells, with a trusted output path", () => {
  assert.deepEqual(
    observeClaude([
      bashCall("side", "sleep 1", { isSidechain: true }),
      { ...bashResult("side"), isSidechain: true },
    ]).shells,
    [],
  );
  const foreground = bashCall("fg", "ls");
  foreground.message.content[0].input.run_in_background = false;
  assert.deepEqual(observeClaude([foreground, bashResult("fg")]).shells, []);
  const [shell] = observeClaude([
    bashCall("odd", "sleep 1"),
    bashResult("odd", "/etc/passwd"),
  ]).shells;
  assert.equal(shell.id, "odd");
  assert.equal("outputFile" in shell, false);
  const other = observeClaude([
    bashCall("odd", "sleep 1"),
    bashResult("odd", "/tmp/claude-501/-p/other-session/tasks/odd.output"),
  ]).shells[0];
  assert.equal("outputFile" in other, false);
});

test("putShell validates ids and keeps at most 100 entries, evicting finished ones first", () => {
  const shells = new Map();
  putShell(shells, "../bad", { command: "x" });
  putShell(shells, "", { command: "x" });
  assert.equal(shells.size, 0);
  putShell(shells, "ok:1_a-b", {
    command: "c".repeat(2000),
    description: "d".repeat(500),
    status: "weird",
  });
  const entry = shells.get("ok:1_a-b");
  assert.deepEqual(
    [entry.command.length, entry.description.length, entry.status],
    [1000, 300, "unknown"],
  );
  const many = new Map();
  putShell(many, "done", { status: "completed" });
  for (let i = 0; i < 100; i++) putShell(many, `s${i}`, { status: "running" });
  assert.equal(many.size, 100);
  assert.equal(many.has("done"), false);
  assert.equal(many.has("s0"), true);
});

test("101 background shells yield 100", () => {
  const records = [];
  for (let i = 0; i < 101; i++)
    records.push(bashCall(`s${i}`, "sleep 1"), bashResult(`s${i}`));
  assert.equal(observeClaude(records).shells.length, 100);
  const tracker = claudeShellTracker();
  for (const record of records) tracker.record(record, null);
  assert.equal(tracker.snapshot().length, 100);
});

test("an OpenCode child continued with its task id is a new run of the same agent", () => {
  const aborted = fixture("opencode-aborted");
  const [first] = observeOpenCode(aborted).subagents;
  assert.deepEqual(
    [first.status, first.runStartedAt],
    ["stopped", new Date(1100).toISOString()],
  );
  // The parent calls the task tool again with task_id: a new part for the same child.
  const part = structuredClone(aborted.messages[0].parts[0]);
  part.id = "part-continued";
  part.state = {
    status: "running",
    input: { ...part.state.input, task_id: "native-child-aborted" },
    metadata: part.state.metadata,
    time: { start: 2000 },
  };
  const continued = {
    ...aborted,
    messages: [
      ...aborted.messages,
      {
        info: { id: "continued", role: "assistant", time: { created: 1900 } },
        parts: [part],
      },
    ],
  };
  const [again] = observeOpenCode(continued).subagents;
  assert.deepEqual(
    [again.id, again.status, again.runStartedAt],
    ["native-child-aborted", "running", new Date(2000).toISOString()],
  );
});
