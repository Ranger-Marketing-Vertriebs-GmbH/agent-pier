import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ClaudeHistoryMetadata } from "../../server/features/chat/claude-history-metadata.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import {
  observeClaude,
  createClaudeObserver,
} from "../../server/features/chat/claude-observability.js";

const call = (id, name, input, messageId = id) => ({
  type: "assistant",
  uuid: messageId,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id, content, is_error = false) => ({
  type: "user",
  uuid: `result-${id}`,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
});
function equivalent(records) {
  for (const chunkSize of [1, 2, 7, 100]) {
    const metadata = new ClaudeHistoryMetadata();
    for (let offset = 0; offset < records.length; offset += chunkSize) {
      const end = Math.min(records.length, offset + chunkSize);
      metadata.update(records.slice(offset, end));
      assert.deepEqual(metadata.snapshot(), {
        tasks: normalizeClaude(records.slice(0, end)).tasks,
        observability: observeClaude(records.slice(0, end)),
      });
    }
  }
}

test("task creates, edits, deletion and late failed results match full normalization across chunks", () => {
  equivalent([
    call("create", "TaskCreate", { subject: "Keep the active task" }),
    result("create", "Task #7 created successfully: Keep the active task"),
    call("edit", "TaskUpdate", {
      taskId: "7",
      subject: "Updated task",
      status: "in_progress",
    }),
    result("edit", "failed", true),
    call(
      "edit-again",
      "TaskUpdate",
      JSON.stringify({ taskId: "7", status: "completed" }),
    ),
    call("delete", "TaskUpdate", { taskId: "7", status: "deleted" }),
    result("delete", "failed", true),
    call("delete-again", "TaskUpdate", { taskId: "7", status: "deleted" }),
    call("create-two", "TaskCreate", { subject: "Input subject" }),
    result("create-two", [
      {
        type: "text",
        text: '{"task":{"id":"8","subject":"Output subject","status":"inProgress"}}',
      },
    ]),
    result("create-two", {
      task: { taskId: "9", subject: "Replacement result", status: "completed" },
    }),
    result("create-two", "failed", true),
  ]);
});

test("todos, duplicate labels and streamed assistant message fragments preserve exact task semantics", () => {
  equivalent([
    call(
      "todo",
      "TodoWrite",
      {
        todos: [
          { content: "Same", status: "pending" },
          { content: "Same", status: "inProgress" },
          { content: "Invalid", status: "unrecognized" },
        ],
      },
      "stream",
    ),
    {
      type: "assistant",
      uuid: "stream",
      message: {
        content: [
          { type: "text", text: "Do not retain this ordinary response" },
          {
            type: "tool_use",
            id: "todo",
            name: "TodoWrite",
            input: { todos: [{ subject: "Newest", id: 4, status: "completed" }] },
          },
        ],
      },
    },
    result("todo", "failed", true),
    call("todo-two", "TodoWrite", { todos: [{ text: "Active", status: "pending" }] }),
    {
      type: "assistant",
      uuid: "todo-two",
      message: { content: "Replaced entire message" },
    },
  ]);
});

test("out-of-order task results and malformed envelopes match normalization", () => {
  equivalent([
    result("before", "Task #1 created successfully: native"),
    call("before", "TaskCreate", { subject: "Delayed call" }),
    result("failed-before", "Failure", true),
    call("failed-before", "TaskUpdate", { taskId: "1", status: "deleted" }),
    {
      ...call("meta", "TodoWrite", { todos: [{ content: "Hidden", status: "pending" }] }),
      isMeta: true,
    },
    {
      type: "assistant",
      uuid: "wrong-role",
      message: {
        role: "user",
        content: [
          { type: "tool_use", id: "bad", name: "TodoWrite", input: { todos: [] } },
        ],
      },
    },
    call("object-subject", "TaskCreate", { subject: "Should not be fallback" }),
    result("object-subject", { id: "2", subject: { invalid: true } }),
  ]);
});

test("incremental observer preserves native agent correlation and latest context across chunks", () => {
  const records = JSON.parse(
    fs.readFileSync(
      new URL("../fixtures/observability/claude.json", import.meta.url),
      "utf8",
    ),
  );
  equivalent(records);
  const observer = createClaudeObserver();
  for (const record of records) observer.update([record]);
  assert.deepEqual(observer.snapshot(), observeClaude(records));
  observer.update([
    { type: "system", subtype: "compact_boundary", timestamp: "2026-09-10" },
  ]);
  assert.equal(observer.snapshot().context.usedTokens, null);
});

test("ordinary messages and unrelated successful tool output consume no retained journal budget", () => {
  const metadata = new ClaudeHistoryMetadata({ maxRecords: 2, maxBytes: 1024 });
  for (let index = 0; index < 1000; index++)
    metadata.update([
      {
        type: "assistant",
        uuid: `ordinary-${index}`,
        message: {
          content: "private transcript ".repeat(100),
          usage: { input_tokens: index },
        },
      },
      call(`read-${index}`, "Read", { file_path: "/private/project" }),
      result(`read-${index}`, "private command output ".repeat(100)),
    ]);
  assert.deepEqual(metadata.stats(), { records: 0, bytes: 0, truncated: false });
  assert.deepEqual(metadata.snapshot().tasks, []);
  assert.equal(metadata.snapshot().observability.context.usedTokens, 999);
  assert.equal(metadata.snapshot().observability.stale, false);
});

test("bounded metadata marks truncation stale and retains last understood active tasks", () => {
  const metadata = new ClaudeHistoryMetadata({ maxRecords: 2, maxBytes: 1024 });
  metadata.update([
    call("create", "TaskCreate", { subject: "Still active" }),
    result("create", "Task #7 created successfully: Still active"),
  ]);
  const before = metadata.snapshot().tasks;
  metadata.update([call("update", "TaskUpdate", { taskId: "7", status: "completed" })]);
  assert.deepEqual(metadata.snapshot().tasks, before);
  assert.equal(metadata.snapshot().observability.stale, true);
  assert.deepEqual(metadata.stats(), { records: 0, bytes: 0, truncated: true });
  metadata.update([call("later", "TodoWrite", { todos: [] })]);
  assert.deepEqual(metadata.snapshot().tasks, before);
});

test("byte bounds and observer identity bounds report stale rather than grow indefinitely", () => {
  const metadata = new ClaudeHistoryMetadata({ maxBytes: 100, maxEntries: 2 });
  metadata.update([
    call("huge", "TodoWrite", {
      todos: [{ content: "x".repeat(1000), status: "pending" }],
    }),
  ]);
  assert.equal(metadata.snapshot().observability.stale, true);
  assert.equal(metadata.stats().bytes, 0);
  const observer = createClaudeObserver({ maxEntries: 2, compact: true });
  observer.update([
    call("a", "Agent", { prompt: "A" }),
    call("b", "Agent", { prompt: "B" }),
    call("c", "Agent", { prompt: "C" }),
  ]);
  assert.equal(observer.snapshot().stale, true);
});
