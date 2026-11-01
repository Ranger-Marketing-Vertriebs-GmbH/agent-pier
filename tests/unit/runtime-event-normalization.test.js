import test from "node:test";
import assert from "node:assert/strict";
import {
  openClawReply,
  openClawRunEvent,
  openClawStep,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-events.js";
import {
  openClawEntry,
  withOpenClawEntries,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-sessions.js";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { createHermesClient } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesEvents } from "../../server/features/assistants/runtimes/hermes/hermes-events.js";
import { hermesStep } from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import { ChatStreams } from "../../server/features/assistants/chat-stream.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { turnKey } from "../../server/features/assistants/message-source.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
  memoryTransport,
} from "../helpers/hermes-fake-gateway.js";
import { agentId, event, settle } from "../helpers/hermes-scripted.js";

// The runtime port normalizes run events (`reply`, `step`) and history messages
// (`entry`) in each adapter (runtimes/agent-runtime.js); feature code reads only those.

const key = "agent:a:main";
const chat = (payload) =>
  openClawRunEvent({
    event: "chat",
    payload: { runId: "r", sessionKey: key, ...payload },
  });
const agent = (stream, data) =>
  openClawRunEvent({
    event: "agent",
    payload: { runId: "r", sessionKey: key, stream, data },
  });

test("OpenClaw chat frames carry their reply: snapshot, appended text or a replacement", () => {
  const snapshot = chat({
    state: "delta",
    deltaText: "Hi",
    message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
  });
  assert.deepEqual(snapshot.reply, { text: "Hi", delta: "Hi", replace: false });
  assert.deepEqual(chat({ state: "delta", deltaText: " there" }).reply, {
    text: undefined,
    delta: " there",
    replace: false,
  });
  assert.deepEqual(chat({ deltaText: "New", replace: true }).reply, {
    text: undefined,
    delta: "New",
    replace: true,
  });
  assert.equal(chat({ message: { content: "Plain" } }).reply.text, "Plain");
  // A snapshot without text blocks places nothing.
  assert.equal(
    openClawReply({ message: { content: [{ type: "image" }] } }).text,
    undefined,
  );
  assert.equal(snapshot.step, null);
  assert.equal(agent("assistant", {}).reply, null);
  const streams = new ChatStreams();
  assert.equal(streams.delta(snapshot), "Hi");
  assert.equal(streams.delta(chat({ deltaText: " there" })), "Hi there");
});

test("OpenClaw agent frames carry their step as run-steps.js reads it", () => {
  const tool = (data) =>
    openClawStep({ stream: "item", data: { kind: "tool", itemId: "tool:1", ...data } });
  assert.deepEqual(tool({ name: "exec", phase: "start", meta: "Build the site" }), {
    type: "tool",
    id: "tool:1",
    name: "exec",
    title: "Build the site",
    phase: "start",
    failed: false,
  });
  // Only exec and process describe a call by a title; others carry raw arguments.
  assert.equal(tool({ name: "web_fetch", meta: "https://x.test" }).title, null);
  assert.equal(tool({ name: "exec", phase: "update" }).phase, "update");
  assert.equal(tool({ name: "exec", phase: "end", status: "denied" }).failed, true);
  assert.equal(tool({ name: "exec", phase: "end", isError: true }).failed, true);
  assert.equal(tool({ name: "exec", phase: "end", status: "completed" }).failed, false);
  assert.equal(openClawStep({ stream: "item", data: { kind: "message" } }), null);
  assert.equal(openClawStep({ stream: "item", data: { kind: "tool" } }), null);
  assert.deepEqual(agent("thinking", { text: "secret" }).step, { type: "thinking" });
  assert.deepEqual(agent("assistant", { delta: "Hi" }).step, { type: "writing" });
  assert.deepEqual(
    agent("run_status", {
      phase: "retrying",
      retryAttempt: 2,
      maxRetries: 3,
      reason: "timeout",
    }).step,
    { type: "status", phase: "retrying", attempt: 2, of: 3, reason: "timeout" },
  );
  assert.deepEqual(agent("lifecycle", { phase: "waiting-approval" }).step, {
    type: "lifecycle",
    phase: "waiting-approval",
  });
  assert.deepEqual(agent("compaction", { phase: "start" }).step, {
    type: "compaction",
    phase: "start",
  });
  assert.equal(agent("command_output", { output: "x" }).step, null);
  assert.equal(
    openClawRunEvent({ event: "exec.approval.requested", payload: {} }).step,
    null,
  );
});

test("OpenClaw history messages carry their entry, which the chat reads", async () => {
  const messages = [
    {
      role: "user",
      content: "Plan dinner",
      timestamp: 10,
      idempotencyKey: "attempt-1:user",
      __openclaw: { id: "u1" },
    },
    {
      role: "user",
      content: "Exec completed",
      provenance: { kind: "internal_system" },
      timestamp: 11,
      __openclaw: { id: "u2" },
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Pasta" },
        { type: "text", text: "tonight" },
      ],
      timestamp: 12,
      __openclaw: { id: "a1", runId: "attempt-1" },
    },
    {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      timestamp: 13,
      __openclaw: { kind: "compaction", id: "c1", tokensBefore: 9, tokensAfter: 2 },
    },
  ];
  const client = { ready: true, call: async () => ({ messages, sessionInfo: {} }) };
  const { sessions } = createOpenClawRuntime({ client });
  const page = await sessions.history({ sessionKey: key, limit: 10 });
  assert.deepEqual(
    page.messages.map((m) => m.entry),
    [
      {
        id: "u1",
        role: "user",
        text: "Plan dinner",
        timestamp: 10,
        runId: null,
        turnKey: "attempt-1",
        internal: false,
        compaction: null,
      },
      {
        id: "u2",
        role: "user",
        text: "Exec completed",
        timestamp: 11,
        runId: null,
        turnKey: null,
        internal: true,
        compaction: null,
      },
      {
        id: "a1",
        role: "assistant",
        text: "Pasta\ntonight",
        timestamp: 12,
        runId: "attempt-1",
        turnKey: null,
        internal: false,
        compaction: null,
      },
      {
        id: "c1",
        role: "system",
        text: "Compaction",
        timestamp: 13,
        runId: null,
        turnKey: null,
        internal: false,
        compaction: { id: "c1", tokensBefore: 9, tokensAfter: 2 },
      },
    ],
  );
  // The raw fields stay for the readers that still read them.
  assert.equal(page.messages[0].__openclaw.id, "u1");
  assert.equal(
    (await sessions.get({ key, limit: 5 })).messages[2].entry.runId,
    "attempt-1",
  );
  assert.equal(turnKey(page.messages[0]), "attempt-1");
  assert.deepEqual(
    publicMessages(page.messages, { compactions: true }).map((m) => m.id),
    ["u1", "a1", "compaction:c1"],
  );
  // A message without an entry is no chat message.
  assert.deepEqual(publicMessages(messages), []);
  assert.deepEqual(withOpenClawEntries([null]), [null]);
  assert.equal(openClawEntry({ role: "user", content: { odd: true } }).text, "");
});

// Hermes's frames of one turn over a scripted gateway whose client knows the agent's
// workspace (hermes-connection.js createHermesClient).
async function hermesTurn() {
  const { transport, peer } = memoryTransport();
  const client = createHermesClient(transport, {
    agentId,
    timeoutMs: 50,
    workspace: "/agents/agent-1/workspace",
  });
  peer.on("frame", (frame) => {
    if (typeof frame.method !== "string") return;
    const result =
      frame.method === "session.create"
        ? {
            session_id: "s1",
            stored_session_id: "s1",
            revision: 0,
            execution_generation: 1,
            prompts: [],
          }
        : frame.method === "prompt.submit"
          ? { admission_id: "ad1" }
          : {};
    peer.send({ jsonrpc: "2.0", id: frame.id, result });
  });
  peer.send(event("gateway.ready"));
  await client.connect({ timeoutMs: 1000 });
  const supervisor = { client, agentId };
  const sessions = hermesSessions(supervisor);
  const seen = [];
  hermesEvents(supervisor).subscribe((e) => seen.push(e));
  const { key: sessionKey } = await sessions.create({ agentId });
  await sessions.send({
    key: sessionKey,
    turn: { message: "go" },
    idempotencyKey: "run-1",
  });
  let seq = 0;
  const frame = (type, payload) =>
    peer.send(
      event(type, "s1", payload, {
        admission_id: "ad1",
        execution_generation: 1,
        seq: ++seq,
      }),
    );
  return { frame, seen, sessionKey };
}

test("a Hermes turn streams its reply from the first delta and shows its steps", async () => {
  const { frame, seen, sessionKey } = await hermesTurn();
  frame("message.start", {});
  frame("thinking.delta", { text: "pondering" });
  frame("message.delta", { text: "Hel" });
  frame("tool.generating", { name: "terminal" });
  frame("tool.start", {
    tool_id: "call-1",
    tool_call_id: "call-1",
    name: "terminal",
    context: "rm -rf build",
    args: { command: "rm -rf build" },
  });
  frame("tool.progress", { tool_id: "call-1", name: "terminal", progress: 0.5 });
  frame("approval.request", {
    kind: "approval",
    prompt_id: "p1",
    execution_generation: 1,
    command: "rm -rf build",
    description: "recursive delete",
    choices: ["once", "deny"],
    timeout_s: 300,
  });
  frame("approval.settled", { prompt_id: "p1" });
  frame("tool.complete", {
    tool_id: "call-1",
    tool_call_id: "call-1",
    name: "terminal",
    is_error: true,
    result: "denied",
  });
  frame("message.delta", { text: null });
  frame("message.delta", { text: "lo" });
  frame("message.complete", { text: "Hello", status: "complete" });
  await settle();

  const texts = seen.filter((e) => e.kind === "text");
  assert.deepEqual(
    texts.map((e) => e.reply),
    [
      { text: "Hel", delta: "Hel", replace: false },
      null,
      { text: "Hello", delta: "lo", replace: false },
    ],
  );
  // The raw payload stays Hermes's own.
  assert.equal(texts[0].payload.text, "Hel");
  const streams = new ChatStreams();
  assert.deepEqual(
    texts.map((e) => streams.delta(e)),
    ["Hel", "Hel", "Hello"],
  );
  assert.equal(seen.at(-1).kind, "finished");
  assert.deepEqual(seen.at(-1).reply, {
    text: "Hello",
    delta: undefined,
    replace: false,
  });

  // The approval request names the agent's workspace, and the run waits for it.
  const requested = seen.find((e) => e.kind === "approval.requested");
  assert.equal(requested.payload.request.cwd, "/agents/agent-1/workspace");
  assert.equal(requested.payload.request.runId, "run-1");
  const phases = seen
    .filter((e) => e.step?.type === "lifecycle")
    .map((e) => [e.kind, e.step.phase]);
  assert.deepEqual(phases, [
    ["started", "start"],
    ["progress", "waiting-approval"],
    ["progress", "approval-resolved"],
  ]);

  const steps = new RunSteps();
  const views = [];
  for (const e of seen) {
    steps.observe(e);
    if (e.runId === "run-1" && steps.view("run-1")) views.push(steps.view("run-1").phase);
  }
  assert.ok(views.includes("thinking"));
  assert.ok(views.includes("writing"));
  assert.ok(views.includes("tool"));
  assert.ok(views.includes("approval"));
  const view = steps.view("run-1");
  assert.deepEqual(view.steps, [
    { id: "thinking:0", kind: "thinking", state: "done" },
    // The call's context is a preview of its arguments: never its label.
    { id: "call-1", kind: "tool", tool: "terminal", label: "", state: "failed" },
  ]);
  assert.equal(sessionKey, requested.sessionKey);
});

test("Hermes steps: tool calls by their call id, thinking, writing and the start", () => {
  assert.deepEqual(hermesStep("message.start", {}), {
    type: "lifecycle",
    phase: "start",
  });
  assert.deepEqual(hermesStep("message.delta", { text: "x" }), { type: "writing" });
  assert.deepEqual(hermesStep("reasoning.delta", { text: "x" }), { type: "thinking" });
  assert.deepEqual(
    hermesStep("tool.complete", { tool_call_id: "c", name: "read_file" }),
    {
      type: "tool",
      id: "c",
      name: "read_file",
      title: null,
      phase: "end",
      failed: false,
    },
  );
  assert.equal(hermesStep("tool.generating", { name: "terminal" }), null);
  assert.equal(hermesStep("tool.start", { name: "terminal" }), null);
  assert.equal(hermesStep("session.info", {}), null);
});

test("Hermes history rows carry unique entries with millisecond timestamps", async () => {
  const supervisor = fakeHermesSupervisor();
  await supervisor.start();
  const runtime = hermesTestRuntime(supervisor);
  const { key: sessionKey } = await runtime.sessions.create({ agentId: "agent-1" });
  const stored = [...supervisor.store.rows.values()][0];
  stored.messages.push(
    { role: "user", text: "ok", timestamp: 1700000000.25, row_id: 7 },
    { role: "assistant", text: "ok", timestamp: 1700000001 },
    { role: "assistant", text: "ok" },
    { role: "user", text: "[System note: resumed]", display_kind: "auto_continue" },
  );
  const page = await runtime.sessions.history({ sessionKey, limit: 10 });
  assert.deepEqual(
    page.messages.map((m) => m.entry),
    [
      {
        id: "row:7",
        role: "user",
        text: "ok",
        timestamp: 1700000000250,
        runId: null,
        turnKey: null,
        internal: false,
        compaction: null,
      },
      {
        id: "at:1",
        role: "assistant",
        text: "ok",
        timestamp: 1700000001000,
        runId: null,
        turnKey: null,
        internal: false,
        compaction: null,
      },
      {
        id: "at:2",
        role: "assistant",
        text: "ok",
        timestamp: 0,
        runId: null,
        turnKey: null,
        internal: false,
        compaction: null,
      },
      {
        id: "at:3",
        role: "user",
        text: "[System note: resumed]",
        timestamp: 0,
        runId: null,
        turnKey: null,
        internal: true,
        compaction: null,
      },
    ],
  );
  // Equal texts stay apart; Hermes's own note is no owner turn.
  assert.deepEqual(
    publicMessages(page.messages).map((m) => [m.id, m.timestamp]),
    [
      ["row:7", 1700000000250],
      ["at:1", 1700000001000],
      ["at:2", 0],
    ],
  );
  // A page names each row by its place in the whole transcript.
  const last = await runtime.sessions.get({ key: sessionKey, limit: 2 });
  assert.deepEqual(
    last.messages.map((m) => m.entry.id),
    ["at:2", "at:3"],
  );
  const cut = await runtime.sessions.history({ sessionKey, limit: 1, maxChars: 4 });
  assert.equal(cut.messages[0].entry.text, "[Sys");
  await supervisor.stop();
});
