import test from "node:test";
import assert from "node:assert/strict";
import { RunSteps, maxSteps } from "../../server/features/assistants/run-steps.js";

// Frames shaped like OpenClaw 2026.10.3 `agent` events
// (tests/integration/assistant-run-steps-contract.test.js pins them).
const key = "agent:a:main";
const agent = (stream, data, runId = "r1") => ({
  event: "agent",
  payload: { runId, sessionKey: key, stream, data, seq: 1, ts: 1 },
});
const tool = (phase, extra = {}) =>
  agent("item", {
    itemId: "tool:c1",
    toolCallId: "c1",
    name: "exec",
    kind: "tool",
    phase,
    title: "Exec Figurenreferenz ermitteln",
    status: phase === "end" ? "completed" : "running",
    meta: "Figurenreferenz ermitteln",
    commandBearing: true,
    ...extra,
  });

function clock() {
  let now = 1000;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test("a tool call becomes a running step and its result finishes it", () => {
  const time = clock();
  const steps = new RunSteps({ now: time.now });
  assert.equal(steps.observe(agent("lifecycle", { phase: "start" })).runId, "r1");
  assert.equal(steps.view("r1").phase, "model");
  steps.observe(tool("start"));
  let view = steps.view("r1");
  assert.equal(view.phase, "tool");
  assert.deepEqual(view.steps, [
    {
      id: "tool:c1",
      kind: "tool",
      tool: "exec",
      label: "Figurenreferenz ermitteln",
      state: "running",
    },
  ]);
  time.advance(500);
  steps.observe(tool("end"));
  view = steps.view("r1");
  assert.equal(view.steps[0].state, "done");
  // A finished tool hands back to the model.
  assert.equal(view.phase, "model");
  assert.equal(view.quietMs, 0);
  time.advance(4000);
  assert.equal(steps.view("r1").quietMs, 4000);
});

test("command output, thinking text and assistant text never reach a step", () => {
  const steps = new RunSteps();
  steps.observe(agent("thinking", { text: "secret plan", delta: "secret plan" }));
  steps.observe(tool("start"));
  steps.observe(
    agent("command_output", {
      itemId: "command:c1",
      phase: "delta",
      toolCallId: "c1",
      name: "exec",
      output: "TOKEN=abc123",
    }),
  );
  steps.observe(agent("assistant", { text: "Hello", delta: "Hello" }));
  const text = JSON.stringify(steps.view("r1"));
  assert.doesNotMatch(text, /secret plan|TOKEN|abc123|Hello/);
  assert.deepEqual(
    steps.view("r1").steps.map((s) => s.kind),
    ["thinking", "tool"],
  );
  assert.equal(steps.view("r1").phase, "writing");
});

test("tool arguments the label could carry are never shown", () => {
  const steps = new RunSteps();
  // Tools other than exec label themselves from raw arguments (a URL, a path, a query).
  steps.observe(
    agent("item", {
      itemId: "tool:w",
      toolCallId: "w",
      name: "web_fetch",
      kind: "tool",
      phase: "start",
      title: "Web fetch https://example.com/?token=abc",
      meta: "https://example.com/?token=abc",
    }),
  );
  // A title that looks like a secret or a command is dropped as well.
  steps.observe(
    tool("start", {
      itemId: "tool:c2",
      meta: `export API_KEY=${["sk", "1234567890abcdef"].join("-")}`,
    }),
  );
  steps.observe(tool("start", { itemId: "tool:c3", meta: "Bild ".repeat(40) }));
  steps.observe(
    tool("start", {
      itemId: "tool:c4",
      meta: ["ghp", "abc123def456ghi789jkl"].join("_"),
    }),
  );
  const view = steps.view("r1");
  assert.deepEqual(
    view.steps.map((s) => [s.tool, s.label]),
    [
      ["web_fetch", ""],
      ["exec", ""],
      ["exec", "Bild ".repeat(40).trim().slice(0, 80)],
      ["exec", ""],
    ],
  );
  assert.doesNotMatch(JSON.stringify(view), /token=abc|sk-1234/);
});

test("a failed tool, a retry and the model's answer", () => {
  const steps = new RunSteps();
  steps.observe(tool("start"));
  steps.observe(tool("end", { status: "failed" }));
  assert.equal(steps.view("r1").steps[0].state, "failed");
  steps.observe(
    agent("run_status", {
      phase: "retrying",
      message: "Provider temporarily unavailable. Retrying in 1s (1/8).",
      retryAttempt: 1,
      maxRetries: 8,
      reason: "timeout",
    }),
  );
  const view = steps.view("r1");
  assert.equal(view.phase, "retrying");
  assert.deepEqual(view.retry, { attempt: 1, of: 8, reason: "timeout" });
  steps.observe(agent("assistant", { delta: "Hi" }));
  assert.equal(steps.view("r1").retry, null);
});

test("steps stay bounded and runs are forgotten oldest first", () => {
  const steps = new RunSteps();
  for (let i = 0; i < maxSteps + 10; i++)
    steps.observe(tool("start", { itemId: `tool:${i}` }));
  const view = steps.view("r1");
  assert.equal(view.steps.length, maxSteps);
  assert.equal(view.omitted, 10);
  assert.equal(view.steps.at(-1).id, `tool:${maxSteps + 9}`);
  for (let i = 0; i < 40; i++)
    steps.observe(agent("lifecycle", { phase: "start" }, `x${i}`));
  assert.equal(steps.view("r1"), null);
  steps.end("x39");
  assert.equal(steps.view("x39"), null);
});

test("frames without a run, session or known stream are ignored", () => {
  const steps = new RunSteps();
  assert.equal(steps.observe({ event: "agent", payload: { stream: "item" } }), null);
  assert.equal(steps.observe({ event: "sessions.changed", payload: {} }), null);
  assert.equal(steps.observe(agent("usage", { outputTokens: 1 })).changed, false);
  // Any frame of the run is a sign of life, even one that adds no step.
  assert.equal(steps.view("r1").phase, "model");
});

test("a chat delta and a chat status count as signs of life", () => {
  const time = clock();
  const steps = new RunSteps({ now: time.now });
  steps.observe(agent("lifecycle", { phase: "start" }));
  time.advance(9000);
  steps.observe({
    event: "chat",
    payload: { runId: "r1", sessionKey: key, state: "status", phase: "starting_model" },
  });
  assert.equal(steps.view("r1").quietMs, 0);
});

test("a tool with a very long item id still finishes its one step", () => {
  const steps = new RunSteps();
  const itemId = `tool:${"x".repeat(300)}`;
  steps.observe(tool("start", { itemId }));
  steps.observe(tool("update", { itemId }));
  steps.observe(tool("end", { itemId }));
  const view = steps.view("r1");
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0].id.length, 128);
  assert.equal(view.steps[0].state, "done");
  assert.equal(view.phase, "model");
});
