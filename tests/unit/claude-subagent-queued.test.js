import test from "node:test";
import assert from "node:assert/strict";
import { observeClaude } from "../../server/features/chat/chat-observability.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import {
  lifecycleRecord,
  subagentEvent,
  subagentKey,
} from "../../server/features/chat/claude-subagents.js";
import {
  handback,
  launch,
  notification,
  queueOperation,
  queuedHandback,
  queuedNotification,
} from "../helpers/claude-subagents.js";

const row = (records, callId) =>
  normalizeClaude(records).messages.find((message) => message.id === callId);
const observed = (records, agentId) =>
  observeClaude(records).subagents.find((agent) => agent.id === agentId);
const human = (prompt) => ({
  type: "attachment",
  uuid: "queued-human",
  attachment: {
    type: "queued_command",
    prompt,
    source_uuid: "human-source",
    commandMode: "prompt",
    origin: { kind: "human" },
  },
});

test("queued-command attachments map to the generated user-record shape", () => {
  const note = queuedNotification("toolu_q", "agentq", "completed");
  const mapped = lifecycleRecord(note);
  assert.equal(mapped.type, "user");
  assert.equal(mapped.origin.kind, "task-notification");
  assert.equal(mapped.message.content, note.attachment.prompt);
  const user = notification("toolu_q", "agentq", "completed");
  assert.equal(lifecycleRecord(user), user);
  assert.equal(lifecycleRecord(queueOperation(note.attachment.prompt)), null);
  assert.equal(lifecycleRecord({ ...note, isSidechain: true }), null);
  assert.equal(lifecycleRecord(human("Hi")), null);
  assert.equal(lifecycleRecord(null), null);
});

test("subagentKey and subagentEvent read both attachment forms", () => {
  const note = queuedNotification("toolu_q", "agentq", "completed");
  assert.deepEqual(subagentKey(note), {
    kind: "notification",
    taskId: "agentq",
    toolUseId: "toolu_q",
  });
  assert.equal(subagentEvent(note).status, "completed");
  assert.equal(subagentEvent(note).summary, "Agent completed");
  assert.equal(
    subagentEvent(queuedNotification("toolu_q", "agentq", "failed")).status,
    "failed",
  );
  assert.equal(
    subagentEvent(queuedNotification("toolu_q", "agentq", "killed")).status,
    "unknown",
  );
  const back = queuedHandback("agentq", "Queued report");
  assert.deepEqual(subagentKey(back), { kind: "handback", agentId: "agentq" });
  assert.equal(subagentEvent(back).status, "completed");
  assert.equal(subagentEvent(back).report, "Queued report");
});

test("unrelated or cancellable records never complete a subagent", () => {
  const note = queuedNotification("toolu_q", "agentq", "completed");
  const cases = {
    "enqueue operation": queueOperation(note.attachment.prompt),
    "sidechain attachment": { ...note, isSidechain: true },
    "peer without hand-back": queuedHandback("agentq", "Note", { handback: false }),
    "human attachment": human(note.attachment.prompt),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(subagentKey(record), null, name);
    const records = [...launch("toolu_q", "agentq", "Queued"), record];
    assert.equal(observed(records, "agentq").status, "running", `observer: ${name}`);
    assert.equal(row(records, "toolu_q").status, "running", `row: ${name}`);
  }
});

test("an async launch completes through an attachment-only notification", () => {
  for (const [status, expected] of [
    ["completed", "completed"],
    ["failed", "failed"],
    ["killed", "unknown"],
  ]) {
    const note = queuedNotification("toolu_q", "agentq", status);
    const records = [
      ...launch("toolu_q", "agentq", "Queued"),
      queueOperation(note.attachment.prompt),
      queueOperation(note.attachment.prompt, "remove"),
      note,
    ];
    assert.equal(observed(records, "agentq").status, expected, status);
    assert.equal(row(records, "toolu_q").status, expected, status);
    assert.equal(row(records, "toolu_q").subagent.status, expected, status);
  }
});

test("an async launch completes through an attachment-only hand-back", () => {
  const records = [
    ...launch("toolu_q", "agentq", "Queued"),
    queuedHandback("agentq", "Queued report"),
  ];
  assert.equal(observed(records, "agentq").status, "completed");
  const agentRow = row(records, "toolu_q");
  assert.equal(agentRow.status, "completed");
  assert.equal(agentRow.text, "Queued report");
  // The attachment itself never becomes a visible chat message.
  assert.equal(normalizeClaude(records).messages.length, 1);
});

test("a completion written both as user record and attachment stays completed", () => {
  const records = [
    ...launch("toolu_q", "agentq", "Queued"),
    queuedNotification("toolu_q", "agentq", "completed"),
    notification("toolu_q", "agentq", "completed"),
    queuedHandback("agentq", "Queued report"),
    handback("agentq", "Queued report"),
  ];
  assert.equal(observed(records, "agentq").status, "completed");
  assert.equal(row(records, "toolu_q").status, "completed");
  assert.equal(row(records, "toolu_q").text, "Queued report");
  assert.equal(normalizeClaude(records).messages.length, 1);
});
