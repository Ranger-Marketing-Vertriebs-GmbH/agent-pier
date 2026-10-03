import test from "node:test";
import assert from "node:assert/strict";
import { observeClaude } from "../../server/features/chat/chat-observability.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { ClaudeHistoryMetadata } from "../../server/features/chat/claude-history-metadata.js";
import { launch, notification, handback } from "../helpers/claude-subagents.js";

const rowStatus = (records, callId) =>
  normalizeClaude(records).messages.find((message) => message.id === callId).status;
const agentStatus = (records, agentId) =>
  observeClaude(records).subagents.find((agent) => agent.id === agentId).status;

test("a launch reusing an agent id does not inherit the earlier run's completion", () => {
  const records = [
    ...launch("toolu_first", "agentreused", "First run"),
    handback("agentreused", "First report"),
    ...launch("toolu_second", "agentreused", "Second run"),
  ];
  assert.equal(rowStatus(records, "toolu_first"), "running");
  assert.equal(rowStatus(records, "toolu_second"), "running");
  assert.equal(agentStatus(records, "agentreused"), "running");
  const row = normalizeClaude(records).messages.find(
    (message) => message.id === "toolu_second",
  );
  assert.doesNotMatch(row.text, /First report/);
  const finished = [...records, handback("agentreused", "Second report")];
  assert.equal(rowStatus(finished, "toolu_second"), "completed");
  assert.equal(agentStatus(finished, "agentreused"), "completed");
});

test("chat rows and the observer apply one precedence rule to event sequences", () => {
  const sequences = {
    "completed then killed": [["completed"], ["killed"], "completed"],
    "failed then killed": [["failed"], ["killed"], "failed"],
    "killed then completed": [["killed"], ["completed"], "completed"],
    "completed then failed": [["completed"], ["failed"], "failed"],
    "failed then hand-back": [["failed"], "handback", "completed"],
    "killed only": [["killed"], null, "unknown"],
  };
  for (const [name, [first, second, expected]] of Object.entries(sequences)) {
    const event = (value) =>
      value === "handback"
        ? [handback("agentseq", "Report")]
        : value
          ? [notification("toolu_seq", "agentseq", value[0])]
          : [];
    const records = [
      ...launch("toolu_seq", "agentseq", "Sequence"),
      ...event(first),
      ...event(second),
    ];
    assert.equal(rowStatus(records, "toolu_seq"), expected, `row: ${name}`);
    assert.equal(agentStatus(records, "agentseq"), expected, `observer: ${name}`);
  }
});

test("more than 100 agents evict finished ones and keep running agents live", () => {
  const records = [];
  for (let i = 0; i < 110; i++) {
    records.push(...launch(`toolu_${i}`, `agent${i}`, `Task ${i}`));
    if (i !== 3 && i < 108) records.push(handback(`agent${i}`, `Report ${i}`));
  }
  for (const result of [
    observeClaude(records),
    new ClaudeHistoryMetadata().update(records).snapshot().observability,
  ]) {
    assert.equal(result.stale, false);
    assert.ok(result.subagents.length <= 100);
    const running = result.subagents
      .filter((agent) => agent.status === "running")
      .map((agent) => agent.id);
    assert.deepEqual(running.sort(), ["agent108", "agent109", "agent3"]);
    assert.equal(
      result.subagents.some((agent) => agent.id === "agent0"),
      false,
    );
  }
});
