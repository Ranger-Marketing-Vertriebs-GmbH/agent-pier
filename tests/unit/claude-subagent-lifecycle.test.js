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
    "killed only": [["killed"], null, "stopped"],
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

// SendMessage to a stopped or finished agent, as Claude Code 2.1.32x writes its result
// in the main transcript (shape from a real session; ids and text neutral).
const resume = (callId, agentId, at, extra = {}) => [
  {
    type: "assistant",
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "SendMessage",
          input: { to: agentId, message: "Go on" },
        },
      ],
    },
  },
  {
    type: "user",
    timestamp: at,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content: "{}" }],
    },
    toolUseResult: {
      success: true,
      message: `Resuming agent ${agentId.slice(0, 7)}`,
      resumedAgentId: agentId,
      revivedAgentId: agentId,
      pin: { id: agentId, name: agentId, ref: "000000" },
      ...extra,
    },
  },
];
const stamped = (records, at) => records.map((record) => ({ ...record, timestamp: at }));

test("a resumed agent runs again from the time of the resume", () => {
  const launched = stamped(
    launch("toolu_run", "agentresumed", "Resumed task"),
    "2026-11-17T10:00:00.000Z",
  );
  const agent = (records) =>
    observeClaude(records).subagents.find((item) => item.id === "agentresumed");
  assert.equal(agent(launched).runStartedAt, "2026-11-17T10:00:00.000Z");
  const finished = [
    ...launched,
    {
      ...notification("toolu_run", "agentresumed", "completed"),
      timestamp: "2026-11-17T10:01:00.000Z",
    },
  ];
  assert.equal(agent(finished).status, "completed");
  const resumed = [
    ...finished,
    ...resume("toolu_send", "agentresumed", "2026-11-17T10:02:00.000Z"),
  ];
  assert.deepEqual(
    [agent(resumed).status, agent(resumed).runStartedAt],
    ["running", "2026-11-17T10:02:00.000Z"],
  );
  // A message queued for a running agent, or a refused resume, is no new run.
  const queued = [
    ...finished,
    ...resume("toolu_q", "agentresumed", "2026-11-17T10:03:00.000Z", {
      resumedAgentId: undefined,
      revivedAgentId: undefined,
      message: "Message queued for delivery",
    }),
  ];
  assert.equal(agent(queued).status, "completed");
  // The resumed run's end names the SendMessage call as its tool-use id (2.1.326).
  const ended = [
    ...resumed,
    {
      ...notification("toolu_send", "agentresumed", "completed"),
      timestamp: "2026-11-17T10:03:00.000Z",
    },
  ];
  assert.deepEqual(
    [agent(ended).status, agent(ended).runStartedAt],
    ["completed", "2026-11-17T10:02:00.000Z"],
  );
  // An unknown agent id stays unknown.
  assert.equal(
    observeClaude(resume("toolu_x", "agentother", "2026-11-17T10:02:00.000Z")).subagents
      .length,
    0,
  );
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
