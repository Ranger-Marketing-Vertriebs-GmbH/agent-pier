import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  observeClaude,
  observeCodex,
  observeOpenCode,
  finalizeObservability,
} from "../../server/features/chat/chat-observability.js";
const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/observability/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("Claude uses only the latest parent request input plus cache, and native agent identities", () => {
  const result = observeClaude(fixture("claude"));
  assert.equal(result.context.usedTokens, 60);
  assert.equal(result.context.limitTokens, null);
  assert.equal(result.context.remainingPercent, null);
  assert.equal(result.context.source, "last-api-request");
  assert.deepEqual(
    result.subagents.map((a) => [a.id, a.name, a.task, a.status]),
    [["native-claude-agent", "reviewer", "Review changes", "completed"]],
  );
  assert.equal(JSON.stringify(result).includes("Private"), false);
  const compacted = observeClaude([
    ...fixture("claude"),
    { type: "system", subtype: "compact_boundary" },
  ]);
  assert.equal(compacted.context.usedTokens, null);
});
test("Codex native token counts exclude cumulative totals and cache double counting", () => {
  const result = observeCodex({}, fixture("codex"));
  assert.equal(result.context.usedTokens, 70000);
  assert.equal(result.context.limitTokens, 128000);
  assert.equal(result.context.remainingPercent, 50);
  assert.equal(result.context.limitSource, "native");
  assert.deepEqual(
    result.subagents.map((a) => [a.id, a.status]),
    [
      ["native-agent-one", "completed"],
      ["native-agent-two", "running"],
    ],
  );
  assert.equal(JSON.stringify(result).includes("Private"), false);
  assert.equal(
    observeCodex({}, [...fixture("codex"), { type: "compacted", payload: {} }]).context
      .usedTokens,
    null,
  );
});
test("Codex tool completion does not complete a receiving agent without its own reported status", () => {
  const result = observeCodex({
    turns: [
      {
        items: [
          {
            type: "collabAgentToolCall",
            status: "completed",
            tool: "spawnAgent",
            receiverThreadIds: ["native-child"],
            prompt: "Review",
            agentsStates: {},
          },
          {
            type: "collabAgentToolCall",
            status: "completed",
            tool: "wait",
            receiverThreadIds: ["other-child"],
            agentsStates: { "other-child": { status: "running", message: "hidden" } },
          },
        ],
      },
    ],
  });
  assert.equal(result.subagents.find((a) => a.id === "native-child").status, "unknown");
  assert.equal(result.subagents.find((a) => a.id === "other-child").status, "running");
});
test("OpenCode reads latest per-request input and cache while background dispatch remains unknown", () => {
  const result = observeOpenCode(fixture("opencode"));
  assert.equal(result.context.usedTokens, 6000);
  assert.equal(result.context.limitTokens, null);
  assert.deepEqual(
    result.subagents.map((a) => [a.id, a.status]),
    [
      ["native-child-one", "unknown"],
      ["native-child-two", "completed"],
    ],
  );
  const reset = fixture("opencode");
  reset.messages.push({ info: { role: "user" }, parts: [{ type: "compaction" }] });
  assert.equal(observeOpenCode(reset).context.usedTokens, null);
});
test("configured limits are labeled separately and never survive a known model mismatch", () => {
  const content = observeOpenCode(fixture("opencode"));
  const session = {
    status: "running",
    provider: {
      assumedContextTokens: 12000,
      requestedModelId: "fixture-model",
      contextStatus: "configured",
    },
  };
  const result = finalizeObservability(content, session);
  assert.equal(result.context.limitSource, "configured");
  assert.equal(result.context.remainingPercent, 50);
  assert.equal(
    finalizeObservability(content, {
      ...session,
      provider: { ...session.provider, requestedModelId: "different" },
    }).context.limitTokens,
    null,
  );
  const native = finalizeObservability(observeCodex({}, fixture("codex")), session);
  assert.equal(native.context.limitTokens, 128000);
  assert.equal(native.context.limitSource, "native");
  assert.equal(
    finalizeObservability(content, { status: "stopped" }).subagents.find(
      (a) => a.id === "native-child-one",
    ).status,
    "unknown",
  );
});
test("malformed, quoted and cumulative-only records never invent usage or subagents", () => {
  const prose = {
    type: "assistant",
    message: {
      content: '{"input_tokens":9000,"agentId":"fake"}',
      usage: { input_tokens: -1 },
    },
  };
  for (const result of [
    observeClaude([
      null,
      prose,
      {
        type: "system",
        subtype: "task_started",
        task_id: "shell-task",
        task_type: "local_bash",
      },
    ]),
    observeCodex({}, [
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 9000 } },
        },
      },
    ]),
    observeOpenCode({
      messages: [
        {
          info: { role: "assistant", tokens: { input: NaN } },
          parts: [{ type: "subtask", id: "part-not-session", agent: "fake" }],
        },
      ],
    }),
  ]) {
    assert.equal(result.context.usedTokens, null);
    assert.deepEqual(result.subagents, []);
  }
});

test("structured Claude task notifications track agents only, never unrelated shell jobs", () => {
  const result = observeClaude([
    {
      type: "system",
      subtype: "task_started",
      task_id: "agent-task",
      task_type: "local_agent",
      description: "Native review",
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "shell-task",
      task_type: "local_bash",
      description: "Build",
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "agent-task",
      status: "completed",
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "shell-task",
      status: "completed",
    },
  ]);
  assert.deepEqual(
    result.subagents.map((a) => [a.id, a.status]),
    [["agent-task", "completed"]],
  );
});

test("Codex structured snapshot takes precedence over older rollout states and token counts", () => {
  const thread = {
    updatedAt: 1788775800,
    tokenUsage: {
      last: { inputTokens: 80000, totalTokens: 90000 },
      modelContextWindow: 160000,
    },
    turns: [
      {
        items: [
          {
            type: "collabAgentToolCall",
            receiverThreadIds: ["native-agent-two"],
            agentsStates: { "native-agent-two": { status: "completed" } },
            status: "completed",
          },
        ],
      },
    ],
  };
  const result = observeCodex(thread, fixture("codex"));
  assert.equal(
    result.subagents.find((a) => a.id === "native-agent-two").status,
    "completed",
  );
  assert.equal(result.context.usedTokens, 90000);
  assert.equal(result.context.limitTokens, 160000);
  const untimed = observeCodex({ ...thread, updatedAt: undefined }, fixture("codex"));
  assert.equal(
    untimed.subagents.find((a) => a.id === "native-agent-two").status,
    "completed",
  );
});
test("a rollout event demonstrably newer than the Codex snapshot remains authoritative", () => {
  const thread = {
    updatedAt: 1,
    tokenUsage: { last: { inputTokens: 10, totalTokens: 12 }, modelContextWindow: 100 },
    turns: [
      {
        items: [
          {
            type: "collabAgentToolCall",
            receiverThreadIds: ["native-agent-two"],
            agentsStates: { "native-agent-two": { status: "completed" } },
          },
        ],
      },
    ],
  };
  const result = observeCodex(thread, fixture("codex"));
  assert.equal(
    result.subagents.find((a) => a.id === "native-agent-two").status,
    "running",
  );
  assert.equal(result.context.usedTokens, 70000);
});

test("Codex context follows last total tokens and the native baseline-normalized percentage", () => {
  const context = observeCodex({}, [
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 12000,
            output_tokens: 6000,
            total_tokens: 18000,
            cached_input_tokens: 10000,
          },
          total_token_usage: { total_tokens: 999999 },
          model_context_window: 128000,
        },
      },
    },
  ]).context;
  assert.equal(context.usedTokens, 18000);
  assert.equal(context.remainingPercent, 95);
});
test("background dispatch completion does not establish a live OpenCode or Claude agent state", () => {
  const opencode = observeOpenCode(fixture("opencode"));
  assert.equal(
    opencode.subagents.find((a) => a.id === "native-child-one").status,
    "unknown",
  );
  const claude = observeClaude([
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Agent",
            id: "spawn-async",
            input: { description: "Work" },
          },
        ],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "spawn-async" }] },
      toolUseResult: { agentId: "async-agent", isAsync: true, status: "launched" },
    },
  ]);
  assert.equal(claude.subagents[0].status, "unknown");
});

test("Claude task and agent metadata correlate only through their shared native tool-use identifier", () => {
  const call = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "shared-call",
          name: "Agent",
          input: { description: "One actual agent" },
        },
      ],
    },
  };
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "native-task-id",
    tool_use_id: "shared-call",
    task_type: "local_agent",
    description: "One actual agent",
  };
  const progress = {
    type: "progress",
    parentToolUseID: "shared-call",
    data: { type: "agent_progress", agentId: "native-agent-id" },
  };
  const completed = {
    type: "system",
    subtype: "task_notification",
    task_id: "native-task-id",
    tool_use_id: "shared-call",
    status: "completed",
  };
  for (const sequence of [
    [call, started, progress, completed],
    [call, progress, started, completed],
  ]) {
    const result = observeClaude(sequence);
    assert.equal(result.subagents.length, 1);
    assert.equal(result.subagents[0].id, "native-agent-id");
    assert.equal(result.subagents[0].status, "completed");
  }
});
