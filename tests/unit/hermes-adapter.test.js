import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import {
  hermesEventKind,
  sessionKeyOf,
  storedIdOf,
} from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import { createHermesClient } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesEvents } from "../../server/features/assistants/runtimes/hermes/hermes-events.js";
import { hermesApprovals } from "../../server/features/assistants/runtimes/hermes/hermes-approvals.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
  memoryTransport,
} from "../helpers/hermes-fake-gateway.js";

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
const agentId = "agent-1";
const event = (type, sid, payload = {}, seq) => ({
  jsonrpc: "2.0",
  method: "event",
  params: { type, session_id: sid, payload, ...(seq ? { seq } : {}) },
});

// A client of agent-1 over a scripted peer: `answer(frame)` returns a result, an
// `{ error }` or undefined (no answer); the sub-ports read it as the supervisor's.
async function scripted(answer = () => ({})) {
  const { transport, peer } = memoryTransport();
  const client = createHermesClient(transport, { agentId, timeoutMs: 50 });
  peer.on("frame", (frame) => {
    if (typeof frame.method !== "string") return;
    if (frame.method === "client.capabilities")
      return peer.send({ jsonrpc: "2.0", id: frame.id, result: {} });
    const out = answer(frame);
    if (out === undefined) return;
    peer.send({ jsonrpc: "2.0", id: frame.id, ...(out.error ? out : { result: out }) });
  });
  peer.send(event("gateway.ready"));
  await client.connect({ timeoutMs: 1000 });
  const supervisor = { client, agentId };
  return {
    client,
    peer,
    supervisor,
    sessions: hermesSessions(supervisor),
    events: hermesEvents(supervisor),
    approvals: hermesApprovals(supervisor),
  };
}

test("session keys name the agent and the stored Hermes session", () => {
  const key = sessionKeyOf(agentId, "20261101_095659_9cb116");
  assert.equal(key, "agent:agent-1:hermes:20261101_095659_9cb116");
  assert.equal(storedIdOf(agentId, key), "20261101_095659_9cb116");
  assert.equal(storedIdOf("agent-2", key), null);
  assert.equal(storedIdOf(agentId, "agent:agent-1:main"), null);
  assert.equal(storedIdOf(agentId, null), null);
});

test("Hermes events map onto the port's run event kinds", () => {
  const cases = [
    ["message.start", {}, true, "started"],
    ["message.delta", {}, true, "text"],
    ["tool.generating", {}, true, "tool"],
    ["tool.start", {}, true, "tool"],
    ["tool.progress", {}, true, "tool"],
    ["tool.complete", {}, true, "tool"],
    ["thinking.delta", {}, true, "progress"],
    ["session.title", {}, true, "progress"],
    ["session.info", {}, false, "other"],
    ["message.complete", { status: "complete" }, true, "finished"],
    ["message.complete", { status: "interrupted" }, true, "aborted"],
    ["message.complete", { status: "error" }, true, "failed"],
    ["error", {}, true, "failed"],
    ["error", {}, false, "other"],
  ];
  for (const [type, payload, inRun, kind] of cases)
    assert.equal(hermesEventKind(type, payload, inRun), kind, `${type} ${inRun}`);
});

test("a submitted turn's events carry its idempotency key as run id", async () => {
  const { peer, sessions, events } = await scripted((frame) =>
    frame.method === "session.create"
      ? { session_id: "s1", stored_session_id: "st1" }
      : frame.method === "prompt.submit"
        ? { status: "streaming" }
        : {},
  );
  const { key } = await sessions.create({ agentId, label: "Chat" });
  assert.equal(key, "agent:agent-1:hermes:st1");
  const create = peer.frames.find((f) => f.method === "session.create");
  assert.equal(typeof create.params.idempotency_key, "string");
  assert.deepEqual(peer.frames.find((f) => f.method === "session.title").params, {
    session_id: "s1",
    title: "Chat",
  });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  peer.send(event("session.info", "s1", { model: "m" }, 1));
  assert.deepEqual(
    await sessions.send({ key, turn: { message: "Hi" }, idempotencyKey: "run-1" }),
    {
      runId: "run-1",
      status: "streaming",
    },
  );
  assert.deepEqual(peer.frames.at(-1).params, { session_id: "s1", text: "Hi" });
  peer.send(event("message.start", "s1", { turn_id: "t1" }, 2));
  peer.send(event("message.delta", "s1", { text: "He" }, 3));
  peer.send(event("message.delta", "s1", { text: "He" }, 3)); // replayed: dropped
  peer.send(event("tool.start", "s1", { name: "terminal" }, 4));
  peer.send(event("thinking.delta", "s1", { text: "" }, 5));
  peer.send(event("message.complete", "s1", { status: "complete", text: "Hello" }, 6));
  peer.send(event("session.info", "s1", {}, 7));
  await settle();
  assert.deepEqual(
    seen.map((e) => [e.event, e.kind, e.runId]),
    [
      ["session.info", "other", null],
      ["message.start", "started", "run-1"],
      ["message.delta", "text", "run-1"],
      ["tool.start", "tool", "run-1"],
      ["thinking.delta", "progress", "run-1"],
      ["message.complete", "finished", "run-1"],
      ["session.info", "other", null],
    ],
  );
  // Hermes's own payload, with the key and run id OpenClaw's payloads carry.
  assert.deepEqual(seen[2].payload, { text: "He", sessionKey: key, runId: "run-1" });
  assert.ok(seen.every((e) => e.sessionKey === key && e.reason === null));
  assert.deepEqual(await sessions.wait({ runId: "run-1", waitMs: 1 }), {
    runId: "run-1",
    status: "ok",
  });
  assert.deepEqual(await sessions.wait({ runId: "unknown", waitMs: 1 }), {
    runId: "unknown",
    status: "timeout",
  });
});

test("queued, interrupted, failed and foreign turns end as their own runs", async () => {
  const { peer, sessions, events } = await scripted((frame) =>
    frame.method === "session.create"
      ? { session_id: "s1", stored_session_id: "st1" }
      : frame.method === "prompt.submit"
        ? { status: frame.params.text === "second" ? "queued" : "streaming" }
        : {},
  );
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({ key, turn: { message: "first" }, idempotencyKey: "a" });
  await sessions.send({ key, turn: { message: "second" }, idempotencyKey: "b" });
  const waiting = sessions.wait({ runId: "b", waitMs: 1000 });
  peer.send(event("message.start", "s1", { turn_id: "t1" }));
  peer.send(event("message.complete", "s1", { status: "interrupted" }));
  peer.send(event("message.start", "s1", { turn_id: "t2" }));
  peer.send(
    event("message.complete", "s1", { status: "error", failure_reason: "timeout" }),
  );
  peer.send(event("message.delta", "s1", { text: "background" }));
  peer.send(
    event("message.complete", "s1", { status: "error", error_surface: { code: "auth" } }),
  );
  await settle();
  const ends = seen.filter((e) => ["aborted", "failed"].includes(e.kind));
  assert.deepEqual(
    ends.map((e) => [e.runId, e.kind, e.reason]),
    [
      ["a", "aborted", null],
      ["b", "failed", "timeout"],
      [seen.find((e) => e.event === "message.delta").runId, "failed", "auth"],
    ],
  );
  assert.match(ends[2].runId, /^hermes-turn:/);
  assert.deepEqual(await waiting, { runId: "b", status: "error", reason: "timeout" });
  assert.equal((await sessions.wait({ runId: "a", waitMs: 1 })).status, "aborted");
});

test("an error event fails a submitted turn that never started", async () => {
  const { peer, sessions, events } = await scripted((frame) =>
    frame.method === "session.create"
      ? { session_id: "s1", stored_session_id: "st1" }
      : { status: "streaming" },
  );
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({ key, turn: { message: "x" }, idempotencyKey: "r" });
  peer.send(
    event("error", "s1", { message: "Turn cancelled before the agent was ready" }),
  );
  await settle();
  assert.deepEqual(
    seen.map((e) => [e.kind, e.runId]),
    [["failed", "r"]],
  );
});

test("an answered refusal of a submit withdraws its run; a timeout keeps it", async () => {
  let submits = 0;
  const { peer, sessions, events } = await scripted((frame) => {
    if (frame.method === "session.create")
      return { session_id: "s1", stored_session_id: "st1" };
    if (frame.method === "prompt.submit")
      return ++submits === 1
        ? { error: { code: 4009, message: "session busy" } }
        : undefined;
    return {};
  });
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await assert.rejects(
    sessions.send({ key, turn: { message: "x" }, idempotencyKey: "refused" }),
    (e) => e.answered && e.code === "BUSY",
  );
  await assert.rejects(
    sessions.send({ key, turn: { message: "y" }, idempotencyKey: "lost" }),
    (e) => e.code === "TIMEOUT",
  );
  peer.send(event("message.start", "s1", {}));
  await settle();
  assert.equal(seen[0].runId, "lost");
});

test("a key outlives a restart: the stored session is resumed into the new process", async () => {
  const supervisor = fakeHermesSupervisor({ agentId });
  await supervisor.start();
  const runtime = hermesTestRuntime(supervisor);
  const { key } = await runtime.sessions.create({ agentId, label: "Chat" });
  await runtime.sessions.send({ key, turn: { message: "one" }, idempotencyKey: "r1" });
  assert.equal((await runtime.sessions.wait({ runId: "r1", waitMs: 1000 })).status, "ok");
  await runtime.host.restart();
  const history = await runtime.sessions.history({ sessionKey: key, limit: 10 });
  assert.deepEqual(
    history.messages.map((m) => [m.role, m.text, m.content[0].text]),
    [
      ["user", "one", "one"],
      ["assistant", "ECHO: one", "ECHO: one"],
    ],
  );
  assert.equal(history.sessionId, storedIdOf(agentId, key));
  assert.equal(history.hasMore, false);
  const resumes = supervisor.peer.frames.filter((f) => f.method === "session.resume");
  assert.deepEqual(
    resumes.map((f) => f.params),
    [{ session_id: storedIdOf(agentId, key) }],
  );
  // A second call uses the live session; only the newest message when limited.
  const last = await runtime.sessions.history({ sessionKey: key, limit: 1 });
  assert.deepEqual(
    last.messages.map((m) => m.text),
    ["ECHO: one"],
  );
  assert.equal(last.hasMore, true);
  assert.equal(
    supervisor.peer.frames.filter((f) => f.method === "session.resume").length,
    1,
  );
  assert.deepEqual(
    (await runtime.sessions.list({ agentId, label: "Chat" })).map((s) => s.key),
    [key],
  );
  assert.deepEqual(
    await runtime.sessions.list({ agentId: "agent-2", label: "Chat" }),
    [],
  );
});

test("a live session Hermes let go is resumed once and the call repeated", async () => {
  let histories = 0;
  const { peer, sessions } = await scripted((frame) => {
    if (frame.method === "session.create")
      return { session_id: "s1", stored_session_id: "st1" };
    if (frame.method === "session.resume") return { session_id: "s2", open_requests: [] };
    if (frame.method === "session.history")
      return ++histories === 1
        ? { error: { code: 4001, message: "session not found" } }
        : { count: 0, messages: [] };
    return {};
  });
  const { key } = await sessions.create({ agentId });
  assert.deepEqual(await sessions.get({ key, limit: 5 }), { messages: [] });
  assert.deepEqual(
    peer.frames
      .filter((f) => /history|resume/.test(f.method))
      .map((f) => [f.method, f.params]),
    [
      ["session.history", { session_id: "s1" }],
      ["session.resume", { session_id: "st1" }],
      ["session.history", { session_id: "s2" }],
    ],
  );
});

test("a create that timed out is repeated with the same idempotency key", async () => {
  const creates = [];
  const { sessions } = await scripted((frame) => {
    if (frame.method !== "session.create") return {};
    creates.push(frame.params.idempotency_key);
    return creates.length === 1
      ? undefined
      : { session_id: "s1", stored_session_id: "st1" };
  });
  const { key } = await sessions.create(
    { agentId, idempotencyKey: "chat-7" },
    { budgetMs: 30000, sleep: async () => {} },
  );
  assert.equal(key, "agent:agent-1:hermes:st1");
  assert.deepEqual(creates, ["chat-7", "chat-7"]);
  // A refusal Hermes answered created nothing; one after the create did.
  assert.equal(
    sessions.notCreated(Object.assign(new Error("x"), { answered: true })),
    true,
  );
  assert.equal(
    sessions.notCreated(Object.assign(new Error("x"), { answered: true, created: true })),
    false,
  );
  await assert.rejects(sessions.create({ agentId: "agent-2" }), (e) =>
    sessions.notCreated(e),
  );
});

test("delete closes the live session first; capability gaps refuse as UNSUPPORTED", async () => {
  const { peer, sessions } = await scripted((frame) =>
    frame.method === "session.create"
      ? { session_id: "s1", stored_session_id: "st1" }
      : frame.method === "session.delete"
        ? { error: { code: 4007, message: "session not found" } }
        : {},
  );
  const { key } = await sessions.create({ agentId });
  await sessions.delete({ key, deleteTranscript: true });
  assert.deepEqual(
    peer.frames.slice(-2).map((f) => [f.method, f.params]),
    [
      ["session.close", { session_id: "s1" }],
      ["session.delete", { session_id: "st1" }],
    ],
  );
  await assert.rejects(
    sessions.downloadArtifact({ sessionKey: key, artifactId: "a", maxBytes: 1 }),
    (e) => e.code === "UNSUPPORTED" && e.status === 501,
  );
  assert.equal(await sessions.reopenRefused({ key, error: new Error("x") }), false);
});

test("a chat title comes from Hermes's one-shot model call", async () => {
  const { peer, sessions } = await scripted(() => ({
    text: '"Budget for next year."\n',
  }));
  assert.deepEqual(
    await sessions.title({ agentId, message: "the budget", reply: "10k" }),
    {
      title: "Budget for next year",
    },
  );
  const call = peer.frames.at(-1);
  assert.equal(call.method, "llm.oneshot");
  assert.equal(call.params.task, "title_generation");
  assert.match(call.params.input, /<message>\nthe budget\n<\/message>/);
});

const approval = (id, extra = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "approval",
  params: {
    session_id: "s1",
    command: "rm -rf build",
    pattern_key: "recursive delete",
    pattern_keys: ["recursive delete"],
    description: "recursive delete",
    allow_permanent: true,
    allow_session: true,
    request_id: "req-1",
    timeout_s: 300,
    choices: ["once", "session", "always", "deny"],
    ...extra,
  },
});

test("an approval request becomes an exec approval and its answer goes back", async () => {
  const { peer, sessions, events, approvals } = await scripted((frame) =>
    frame.method === "session.create"
      ? { session_id: "s1", stored_session_id: "st1" }
      : { status: "streaming" },
  );
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({
    key,
    turn: { message: "RUN: rm -rf build" },
    idempotencyKey: "run-1",
  });
  peer.send(event("message.start", "s1", {}));
  peer.send(approval("srq-1"));
  await settle();
  const requested = seen.find((e) => e.kind === "approval.requested");
  assert.equal(requested.event, "exec.approval.requested");
  assert.equal(requested.sessionKey, key);
  assert.equal(requested.runId, "run-1");
  const { payload } = requested;
  assert.equal(payload.id, "srq-1");
  assert.equal(payload.expiresAtMs - payload.createdAtMs, 300000);
  assert.deepEqual(
    { ...payload.request, hermes: undefined },
    {
      command: "rm -rf build",
      cwd: null,
      agentId,
      sessionKey: key,
      runId: "run-1",
      // Hermes's "always" allows the whole pattern for good: never offered.
      allowedDecisions: ["allow-once", "allow-session", "deny"],
      warningText: "recursive delete",
      hermes: undefined,
    },
  );
  assert.deepEqual(payload.request.hermes.patternKeys, ["recursive delete"]);
  assert.deepEqual(
    (await approvals.list()).map((i) => i.id),
    ["srq-1"],
  );
  await assert.rejects(
    approvals.resolve({ id: "srq-1", decision: "allow-always" }),
    (e) => e.answered === true && e.code === "INVALID_REQUEST",
  );
  await approvals.resolve({ id: "srq-1", decision: "allow-once" });
  await settle();
  assert.deepEqual(peer.frames.at(-1), {
    jsonrpc: "2.0",
    id: "srq-1",
    result: { choice: "once" },
  });
  const resolved = seen.find((e) => e.kind === "approval.resolved");
  assert.equal(resolved.event, "exec.approval.resolved");
  assert.deepEqual(
    {
      id: resolved.payload.id,
      decision: resolved.payload.decision,
      by: resolved.payload.resolvedBy,
    },
    { id: "srq-1", decision: "allow-once", by: "owner" },
  );
  peer.send(approval("srq-2"));
  await settle();
  await approvals.resolve({ id: "srq-2", decision: "allow-session" });
  await settle();
  assert.deepEqual(peer.frames.at(-1).result, { choice: "session" });
  assert.deepEqual(
    (await approvals.history()).items.map((i) => [i.id, i.status, i.decision]),
    [
      ["srq-1", "allowed", "allow-once"],
      ["srq-2", "allowed", "allow-session"],
    ],
  );
  await assert.rejects(
    approvals.resolve({ id: "srq-1", decision: "deny" }),
    (e) => e.answered === true,
  );
});

test("a withdrawn approval ends as expired or cancelled; a closed one cannot be answered", async () => {
  const { client, peer, events, approvals } = await scripted();
  const seen = [];
  events.subscribe((e) => seen.push(e));
  peer.send(approval("srq-1", { allow_session: false, choices: ["once", "deny"] }));
  peer.send(approval("srq-2"));
  peer.send(approval("srq-3"));
  await settle();
  assert.deepEqual((await approvals.list())[0].request.allowedDecisions, [
    "allow-once",
    "deny",
  ]);
  peer.send(
    event("request.cancel", "s1", { id: "srq-1", method: "approval", reason: "timeout" }),
  );
  peer.send(
    event("request.cancel", "s1", {
      id: "srq-2",
      method: "approval",
      reason: "interrupt",
    }),
  );
  peer.send(
    event("request.cancel", "s1", { id: "srq-9", method: "clarify", reason: "timeout" }),
  );
  await settle();
  assert.deepEqual(
    (await approvals.history()).items.map((i) => [
      i.id,
      i.status,
      i.decision,
      i.resolvedBy,
    ]),
    [
      ["srq-1", "expired", null, "timeout"],
      ["srq-2", "cancelled", null, "interrupt"],
    ],
  );
  assert.deepEqual(
    seen.filter((e) => e.kind === "approval.resolved").map((e) => e.payload.decision),
    [null, null],
  );
  // A replayed request (open_requests after a resume) is not asked twice.
  peer.send(approval("srq-3"));
  await settle();
  assert.equal(seen.filter((e) => e.kind === "approval.requested").length, 3);
  const bound = hermesApprovals({ client }).on(null);
  await assert.rejects(bound.list(), (e) => e.code === "UNAVAILABLE");
  client.close();
  await assert.rejects(
    approvals.resolve({ id: "srq-3", decision: "deny" }),
    (e) => e.code === "UNAVAILABLE" && e.status === 503,
  );
  assert.deepEqual(approvals.allowAlwaysPlan({ command: "rm -rf x" }), {
    kind: "once",
    reason: "pattern",
  });
});

test("questions the adapter does not answer fail fast with -32601", async () => {
  const { peer } = await scripted();
  peer.send({
    jsonrpc: "2.0",
    id: "srq-c",
    method: "clarify",
    params: { session_id: "s1" },
  });
  peer.send({
    jsonrpc: "2.0",
    id: "srq-s",
    method: "secret",
    params: { session_id: "s1" },
  });
  await settle();
  assert.deepEqual(
    peer.frames
      .filter((f) => f.id === "srq-c" || f.id === "srq-s")
      .map((f) => f.error.code),
    [-32601, -32601],
  );
});
