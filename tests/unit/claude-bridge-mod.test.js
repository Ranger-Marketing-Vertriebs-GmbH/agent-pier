import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../../server/features/claude-mod/bridge-mod.js";
import { fakeModRuntime } from "../helpers/fake-mod-runtime.js";

const TOKEN = "a".repeat(64);
const env = {
  AGENTPIER_CLAUDE_BRIDGE_SOCKET: "/tmp/agentpier-requests-1-x/claude-mod.sock",
  AGENTPIER_REQUEST_FILE: "/data/requests/session-1.launch.json",
  AGENTPIER_REQUEST_TOKEN: TOKEN,
};
const TURN = "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10";

async function loaded(options = {}) {
  const runtime = fakeModRuntime({ env, ...options });
  register(runtime.on);
  await runtime.dispatch("session.start", { cwd: "/p", isInteractive: true });
  await runtime.tick();
  return runtime;
}
const text = (index, value) => ({ kind: "text", index, text: value, ref: 1 });

test("the mod says hello over the broker's socket with this launch's credentials", async () => {
  const runtime = await loaded();
  assert.equal(runtime.requests.length, 1);
  const [request] = runtime.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "http://agentpier/claude-mod/v1/events");
  assert.equal(request.socketPath, env.AGENTPIER_CLAUDE_BRIDGE_SOCKET);
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers["x-agentpier-session"], "session-1");
  assert.deepEqual(request.body, {
    protocol: 1,
    prompts: true,
    events: [{ type: "hello", protocol: 1, cli: "2.1.304" }],
  });
});

test("without AgentPier's launch environment the mod stays quiet", async () => {
  for (const missing of Object.keys(env)) {
    const runtime = fakeModRuntime({ env: { ...env, [missing]: undefined } });
    register(runtime.on);
    await runtime.dispatch("session.start", {});
    await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
    await runtime.stream("turn.step", { turnId: TURN, index: 0 }, [text(0, "Hi")]);
    await runtime.tick();
    await runtime.tick();
    assert.equal(runtime.requests.length, 0, missing);
  }
});

test("token deltas pass through unchanged and reach AgentPier batched, in order", async () => {
  const runtime = await loaded();
  await runtime.dispatch("turn.start", { turnId: TURN, text: "secret prompt" });
  const chunks = [
    { kind: "thinking", index: 0, text: "private reasoning", ref: 1 },
    { kind: "thinking", index: 0, text: " more", ref: 2 },
    text(1, "Hel"),
    text(1, "lo"),
    { kind: "engine", ref: 3 },
    text(2, " second block"),
    { kind: "stop", stopReason: "end_turn", usage: null, ref: 4 },
  ];
  const result = { answer: "Hello second block", toolUses: [] };
  const step = await runtime.stream(
    "turn.step",
    { turnId: TURN, index: 0 },
    chunks,
    result,
  );
  assert.deepEqual(step.chunks, chunks, "the TUI sees every chunk as it came");
  assert.equal(step.result, result);
  await runtime.tick();
  const events = runtime.events().slice(1);
  assert.deepEqual(events, [
    { type: "turn.start", turn: TURN },
    { type: "phase", turn: TURN, phase: "thinking" },
    { type: "text", turn: TURN, step: 0, block: 1, order: 0, from: 0, text: "Hello" },
    {
      type: "text",
      turn: TURN,
      step: 0,
      block: 2,
      order: 1,
      from: 0,
      text: " second block",
    },
  ]);
  const wire = JSON.stringify(runtime.requests.map((request) => request.body));
  assert.doesNotMatch(wire, /private reasoning|secret prompt/, "no thinking, no prompt");
  await runtime.stream("turn.step", { turnId: TURN, index: 0 }, [text(1, "!")]);
  await runtime.tick();
  assert.deepEqual(runtime.events().at(-1), {
    type: "text",
    turn: TURN,
    step: 0,
    block: 1,
    order: 0,
    from: 5,
    text: "!",
  });
});

test("a hook never waits for AgentPier", async () => {
  // A server that never answers: chunks still flow and hooks still return.
  const runtime = await loaded({ fetch: () => new Promise(() => {}) });
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  const many = Array.from({ length: 200 }, (_, i) => text(0, `t${i}`));
  const step = await runtime.stream("turn.step", { turnId: TURN, index: 0 }, many);
  assert.equal(step.chunks.length, 200);
  await runtime.tick();
  const result = await runtime.dispatch("tool.call", {
    tool: "Bash",
    tool_use_id: "toolu_1",
  });
  assert.equal(result.tool, "Bash");
  assert.ok(runtime.requests.length <= 2, "one request in flight at a time");
});

test("tool calls, subagents, compaction and the turn's end are reported", async () => {
  const runtime = await loaded();
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  const answer = { text: "file list", isError: false };
  const result = await runtime.dispatch(
    "tool.call",
    { tool: "Bash", tool_use_id: "toolu_1", command: "ls" },
    async () => answer,
  );
  assert.equal(result, answer, "the tool's answer is passed on unchanged");
  await runtime.dispatch(
    "agent.spawn",
    { tool_use_id: "toolu_2", prompt: "p", description: "d", subagentType: "Explore" },
    async () => ({ model: "m", agentId: "agent-7" }),
  );
  await runtime.dispatch("turn.start", {
    turnId: "sub-turn",
    text: "p",
    agentId: "agent-7",
  });
  // A subagent's text and tools stay out of the session's reply.
  const sub = await runtime.stream(
    "turn.step",
    { turnId: "sub-turn", index: 0, agentId: "agent-7" },
    [text(0, "child text")],
  );
  assert.equal(sub.chunks.length, 1);
  await runtime.dispatch("tool.call", {
    tool: "Read",
    tool_use_id: "toolu_3",
    agentId: "agent-7",
  });
  await runtime.dispatch("turn.complete", {
    turnId: "sub-turn",
    agentId: "agent-7",
    answer: "",
    durationMs: 5,
    isAborted: false,
    reason: "answer",
  });
  await runtime.dispatch("session.compact", { trigger: "precompute", messages: [] });
  await runtime.dispatch("session.compact", { trigger: "auto", messages: [] });
  await runtime.dispatch("turn.complete", {
    turnId: TURN,
    answer: "done",
    durationMs: 1234.4,
    isAborted: true,
    reason: "aborted",
    usage: { input_tokens: 10, output_tokens: 20, model: "x" },
  });
  await runtime.tick();
  assert.deepEqual(runtime.events().slice(2), [
    { type: "tool.start", id: "toolu_1", name: "Bash" },
    { type: "tool.end", id: "toolu_1" },
    { type: "agent.start", id: "agent-7", kind: "Explore" },
    { type: "agent.end", id: "agent-7" },
    { type: "compact.start" },
    { type: "compact.end" },
    {
      type: "turn.complete",
      turn: TURN,
      aborted: true,
      durationMs: 1234,
      usage: { input: 10, output: 20 },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(runtime.events()), /child text|file list|"ls"/);
});

test("a failing tool still ends its status, and the hook's failure handler passes", async () => {
  const runtime = await loaded();
  await assert.rejects(
    runtime.dispatch("tool.call", { tool: "Bash", tool_use_id: "toolu_9" }, async () => {
      throw Error("boom");
    }),
    /boom/,
  );
  await runtime.tick();
  assert.deepEqual(runtime.events().slice(-1), [{ type: "tool.end", id: "toolu_9" }]);
  const handler = runtime.hooks.get("tool.call").catch;
  assert.deepEqual(await handler(runtime.$, { a: 1 }, async (e) => ({ ...e, ok: 1 })), {
    a: 1,
    ok: 1,
  });
});

test("a failed request sends the turn's text again from its start", async () => {
  let fail = true;
  const runtime = await loaded({
    fetch: async () =>
      fail ? Promise.reject(Error("down")) : { status: 200, ok: true, text: "{}" },
  });
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  await runtime.stream("turn.step", { turnId: TURN, index: 0 }, [text(0, "abc")]);
  await runtime.tick();
  fail = false;
  await runtime.stream("turn.step", { turnId: TURN, index: 0 }, [text(0, "def")]);
  await runtime.tick();
  await runtime.tick();
  const last = runtime.requests.at(-1).body.events;
  assert.deepEqual(
    last.find((e) => e.type === "turn.start"),
    { type: "turn.start", turn: TURN },
  );
  assert.deepEqual(
    last.filter((e) => e.type === "text").map((e) => [e.from, e.text]),
    [[0, "abcdef"]],
  );
});

test("AgentPier can ask for whole runs again, and a foreign launch silences the mod", async () => {
  let answer = { status: 200, ok: true, text: '{"resync":true}' };
  const runtime = await loaded({ fetch: async () => answer });
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  await runtime.stream("turn.step", { turnId: TURN, index: 0 }, [text(0, "abc")]);
  await runtime.tick();
  answer = { status: 200, ok: true, text: "{}" };
  await runtime.tick();
  assert.deepEqual(runtime.events().at(-1), {
    type: "text",
    turn: TURN,
    step: 0,
    block: 0,
    order: 0,
    from: 0,
    text: "abc",
  });
  answer = { status: 401, ok: false, text: "{}" };
  await runtime.stream("turn.step", { turnId: TURN, index: 0 }, [text(0, "d")]);
  await runtime.tick();
  const count = runtime.requests.length;
  await runtime.dispatch("turn.complete", {
    turnId: TURN,
    answer: "",
    durationMs: 1,
    isAborted: false,
    reason: "answer",
  });
  await runtime.tick();
  assert.equal(runtime.requests.length, count, "no more requests after a 401");
});

test("/clear is no goodbye; the session's end is", async () => {
  const runtime = await loaded();
  await runtime.dispatch("session.end", { reason: "clear", sessionId: "x" });
  await runtime.tick();
  assert.equal(runtime.events().length, 1);
  await runtime.dispatch("session.end", { reason: "prompt_input_exit", sessionId: "x" });
  await runtime.tick();
  assert.deepEqual(runtime.events().at(-1), { type: "session.end" });
});

test("a composer prompt that entered is reported with its image names", async () => {
  const runtime = await loaded();
  const e = {
    text: "[Image #1] [Image #2] secret prompt",
    attachments: [
      { type: "image", mediaType: "image/png", filename: "red.png", id: "media_1" },
      { type: "document", filename: "notes.pdf", id: "media_2" },
      { type: "image", mediaType: "image/png", id: "media_3" },
      { type: "image", filename: "bad/name.png", id: "media_4" },
    ],
    wait: false,
    origin: { kind: "composer" },
  };
  const entered = { text: e.text, origin: { kind: "composer" } };
  const result = await runtime.dispatch("prompt.submit", e, async () => entered);
  assert.equal(result, entered, "the prompt's result is passed on unchanged");
  await runtime.dispatch(
    "prompt.submit",
    { text: "later please", wait: false, turnId: TURN, origin: { kind: "composer" } },
    async (input) => ({ text: input.text }),
  );
  await runtime.tick();
  const events = runtime.events().slice(1);
  assert.equal(typeof events[0].at, "number");
  assert.deepEqual(
    events.map((event) => ({ ...event, at: 0 })),
    [
      // An image without a usable name keeps its place, so the count stays right.
      { type: "prompt.accepted", at: 0, images: ["red.png", "?", "?"], queued: false },
      { type: "prompt.accepted", at: 0, images: [], queued: true },
    ],
  );
  assert.doesNotMatch(JSON.stringify(runtime.events()), /secret prompt|later please/);
});

test("a dropped prompt is reported without the prompt the engine appends", async () => {
  const runtime = await loaded();
  const reason =
    "UserPromptSubmit operation blocked by hook:\n[/x/hook.sh]: blocked by spike" +
    "\n\n\nOriginal prompt: BLOCKME secret";
  const drop = { drop: reason };
  const result = await runtime.dispatch(
    "prompt.submit",
    {
      text: "BLOCKME secret",
      attachments: [{ type: "image", filename: "red.png" }],
      wait: false,
      origin: { kind: "composer" },
    },
    async () => drop,
  );
  assert.equal(result, drop);
  await runtime.dispatch(
    "prompt.submit",
    { text: "x", wait: false, origin: { kind: "composer" } },
    async () => ({ drop: "y".repeat(800) }),
  );
  await runtime.tick();
  const [blocked, long] = runtime.events().slice(1);
  assert.deepEqual(
    { ...blocked, at: 0 },
    {
      type: "prompt.dropped",
      at: 0,
      images: ["red.png"],
      reason:
        "UserPromptSubmit operation blocked by hook:\n[/x/hook.sh]: blocked by spike",
    },
  );
  assert.equal(long.reason.length, 500);
  assert.doesNotMatch(JSON.stringify(runtime.events()), /secret/);
});

test("prompts from elsewhere are not reported, and the mod's own failure never blocks one", async () => {
  const runtime = await loaded();
  for (const kind of ["bridge", "sdk", "task-notification", "plugin", "peer"])
    await runtime.dispatch("prompt.submit", { text: "x", wait: false, origin: { kind } });
  await runtime.dispatch("prompt.submit", { text: "x", wait: false });
  // Attachments the mod cannot read: the prompt still enters, unchanged.
  const e = {
    text: "x",
    wait: false,
    origin: { kind: "composer" },
    get attachments() {
      throw Error("boom");
    },
  };
  const entered = { text: "x" };
  assert.equal(await runtime.dispatch("prompt.submit", e, async () => entered), entered);
  await runtime.tick();
  assert.equal(runtime.events().length, 1, "only the hello");
  // The engine's own failure goes to the failure handler, which passes.
  const handler = runtime.hooks.get("prompt.submit").catch;
  assert.deepEqual(await handler(runtime.$, { text: "x" }, async (input) => input), {
    text: "x",
  });
});

test("prompt reports survive a failed request", async () => {
  let fail = true;
  const runtime = await loaded({
    fetch: async () =>
      fail ? Promise.reject(Error("down")) : { status: 200, ok: true, text: "{}" },
  });
  await runtime.dispatch("prompt.submit", {
    text: "x",
    wait: false,
    origin: { kind: "composer" },
  });
  await runtime.tick();
  fail = false;
  await runtime.tick();
  assert.deepEqual(
    runtime.requests.at(-1).body.events.map((event) => event.type),
    ["hello", "prompt.accepted"],
  );
});
