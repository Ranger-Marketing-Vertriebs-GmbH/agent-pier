import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesEventKind,
  sessionKeyOf,
  storedIdOf,
} from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
} from "../helpers/hermes-fake-gateway.js";
import { agentId, event, refusal, scripted, settle } from "../helpers/hermes-scripted.js";

const snapshot = (extra = {}) => ({
  session_id: "s1",
  stored_session_id: "s1",
  revision: 0,
  execution_generation: 0,
  subscription_id: "sub-1",
  prompts: [],
  ...extra,
});

test("session keys name the agent and the stored Hermes session", () => {
  const key = sessionKeyOf(agentId, "local-9cb116");
  assert.equal(key, "agent:agent-1:hermes:local-9cb116");
  assert.equal(storedIdOf(agentId, key), "local-9cb116");
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

test("a submitted turn's frames carry its admission, so its idempotency key is the run id", async () => {
  const { peer, sessions, events } = await scripted((frame) =>
    frame.method === "session.create"
      ? snapshot()
      : frame.method === "prompt.submit"
        ? { admission_id: "ad1", status: "queued" }
        : {},
  );
  const { key } = await sessions.create({ agentId, label: "Chat" });
  assert.equal(key, "agent:agent-1:hermes:s1");
  const create = peer.frames.find((f) => f.method === "session.create");
  assert.equal(typeof create.params.request_id, "string");
  // The label is the session's title, set by the create itself.
  assert.equal(create.params.title, "Chat");
  const seen = [];
  events.subscribe((e) => seen.push(e));
  peer.send(event("session.info", "s1", { revision: 0 }, { seq: 1 }));
  assert.deepEqual(
    await sessions.send({ key, turn: { message: "Hi" }, idempotencyKey: "run-1" }),
    { runId: "run-1", status: "queued" },
  );
  assert.deepEqual(peer.frames.at(-1).params, {
    session_id: "s1",
    text: "Hi",
    submission_id: "run-1",
  });
  const turn = (seq) => ({ seq, admission_id: "ad1", execution_generation: 1 });
  peer.send(event("message.start", "s1", {}, turn(2)));
  peer.send(event("message.delta", "s1", { text: "He" }, turn(3)));
  peer.send(event("message.delta", "s1", { text: "He" }, turn(3))); // replayed: dropped
  peer.send(event("tool.start", "s1", { name: "terminal" }, turn(4)));
  peer.send(event("thinking.delta", "s1", { text: "" }, turn(5)));
  peer.send(
    event("message.complete", "s1", { status: "complete", text: "Hello" }, turn(6)),
  );
  peer.send(event("session.info", "s1", { revision: 1 }, turn(7)));
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
      ? snapshot()
      : frame.method === "prompt.submit"
        ? { admission_id: `ad-${frame.params.submission_id}`, status: "queued" }
        : {},
  );
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({ key, turn: { message: "first" }, idempotencyKey: "a" });
  await sessions.send({ key, turn: { message: "second" }, idempotencyKey: "b" });
  const waiting = sessions.wait({ runId: "b", waitMs: 1000 });
  const of = (admission) => ({ admission_id: admission });
  // Hermes runs them in its own order; a routine's turn comes in between.
  peer.send(event("message.start", "s1", {}, of("ad-b")));
  peer.send(
    event(
      "message.complete",
      "s1",
      { status: "error", failure_reason: "timeout" },
      of("ad-b"),
    ),
  );
  peer.send(event("message.delta", "s1", { text: "routine" }, of("ad-x")));
  peer.send(
    event(
      "message.complete",
      "s1",
      { status: "error", error_surface: { code: "auth" } },
      of("ad-x"),
    ),
  );
  peer.send(event("message.start", "s1", {}, of("ad-a")));
  peer.send(event("message.complete", "s1", { status: "interrupted" }, of("ad-a")));
  await settle();
  const ends = seen.filter((e) => ["aborted", "failed"].includes(e.kind));
  assert.deepEqual(
    ends.map((e) => [e.runId, e.kind, e.reason]),
    [
      ["b", "failed", "timeout"],
      ["hermes-turn:ad-x", "failed", "auth"],
      ["a", "aborted", null],
    ],
  );
  assert.deepEqual(await waiting, { runId: "b", status: "error", reason: "timeout" });
  assert.equal((await sessions.wait({ runId: "a", waitMs: 1 })).status, "aborted");
});

test("an error event of a submitted turn that never started fails it", async () => {
  const { peer, sessions, events } = await scripted((frame) =>
    frame.method === "session.create" ? snapshot() : { admission_id: "ad1" },
  );
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({ key, turn: { message: "x" }, idempotencyKey: "r" });
  peer.send(
    event("error", "s1", { message: "agent init failed" }, { admission_id: "ad1" }),
  );
  peer.send(event("error", "s1", { message: "compression failed" }));
  await settle();
  assert.deepEqual(
    seen.map((e) => [e.kind, e.runId]),
    [
      ["failed", "r"],
      ["other", null],
    ],
  );
});

test("an answered refusal of a submit withdraws its run; a timeout keeps it", async () => {
  let submits = 0;
  const { peer, sessions, events } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "prompt.submit")
      return ++submits === 1 ? refusal("session_busy") : undefined;
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
  // The lost answer's turn still starts; its frames name an admission never seen.
  peer.send(event("message.start", "s1", {}, { admission_id: "ad-lost" }));
  await settle();
  assert.equal(seen[0].runId, "lost");
});

test("a key outlives a restart: the transcript reads at once, a turn attaches first", async () => {
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
  const resumes = () =>
    supervisor.peer.frames.filter((f) => f.method === "session.resume");
  assert.deepEqual(resumes(), []);
  const last = await runtime.sessions.history({ sessionKey: key, limit: 1 });
  assert.deepEqual(
    last.messages.map((m) => m.text),
    ["ECHO: one"],
  );
  assert.equal(last.hasMore, true);
  // The new connection attaches once, then submits.
  await runtime.sessions.send({ key, turn: { message: "two" }, idempotencyKey: "r2" });
  await runtime.sessions.send({ key, turn: { message: "three" }, idempotencyKey: "r3" });
  assert.deepEqual(
    resumes().map((f) => f.params),
    [{ session_id: storedIdOf(agentId, key), omit_messages: true }],
  );
  assert.equal((await runtime.sessions.wait({ runId: "r3", waitMs: 1000 })).status, "ok");
  assert.deepEqual(
    (await runtime.sessions.list({ agentId, label: "Chat" })).map((s) => s.key),
    [key],
  );
  assert.deepEqual(
    await runtime.sessions.list({ agentId: "agent-2", label: "Chat" }),
    [],
  );
});

test("a submit refused for a session not attached here attaches it and goes again", async () => {
  let submits = 0;
  const { peer, sessions } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "session.resume") return snapshot({ subscription_id: "sub-2" });
    if (frame.method === "prompt.submit")
      return ++submits === 1 ? refusal("permission_denied") : { admission_id: "ad1" };
    return {};
  });
  const { key } = await sessions.create({ agentId });
  assert.equal(
    (await sessions.send({ key, turn: { message: "x" }, idempotencyKey: "r" })).runId,
    "r",
  );
  assert.deepEqual(
    peer.frames.filter((f) => /submit|resume/.test(f.method)).map((f) => f.method),
    ["prompt.submit", "session.resume", "prompt.submit"],
  );
});

test("a create that timed out is repeated with the same request id", async () => {
  const creates = [];
  const { sessions } = await scripted((frame) => {
    if (frame.method !== "session.create") return {};
    creates.push(frame.params.request_id);
    return creates.length === 1 ? undefined : snapshot();
  });
  const { key } = await sessions.create(
    { agentId, idempotencyKey: "chat-7" },
    { budgetMs: 30000, sleep: async () => {} },
  );
  assert.equal(key, "agent:agent-1:hermes:s1");
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

test("edits are fenced on the session's revision and repeated once on a conflict", async () => {
  let mutates = 0;
  const { peer, sessions } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot({ revision: 2 });
    if (frame.method === "session.resume") return refusal("not_found");
    if (frame.method !== "session.mutate") return {};
    if (frame.params.operation === "delete" && ++mutates === 1)
      return refusal("revision_conflict", { revision: 5, execution_generation: 3 });
    return { revision: frame.params.expected_revision + 1 };
  });
  const { key } = await sessions.create({ agentId });
  await sessions.compact({ key, timeoutMs: 1000 });
  await sessions.delete({ key, deleteTranscript: false });
  await sessions.delete({ key, deleteTranscript: true });
  const edits = peer.frames.filter((f) => f.method === "session.mutate");
  assert.deepEqual(
    edits.map((f) => [
      f.params.operation,
      f.params.expected_revision,
      f.params.expected_generation,
    ]),
    [
      ["compress", 2, 0],
      ["archive", 3, undefined],
      ["delete", 4, 0],
      // Again with the fences the refusal named, under the same request id.
      ["delete", 5, 3],
    ],
  );
  assert.equal(edits[2].params.request_id, edits[3].params.request_id);
  assert.deepEqual(edits[1].params.payload, { archived: true });
  // A deleted key attaches again and finds nothing.
  assert.equal(await sessions.keepOpen({ key }), "missing");
  await assert.rejects(
    sessions.downloadArtifact({ sessionKey: key, artifactId: "a", maxBytes: 1 }),
    (e) => e.code === "UNSUPPORTED" && e.status === 501,
  );
  assert.equal(await sessions.reopenRefused({ key, error: new Error("x") }), false);
});

test("abort interrupts the current generation, or cancels a turn still queued", async () => {
  let interrupts = 0;
  const { peer, sessions } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "prompt.submit")
      return { admission_id: `ad-${frame.params.submission_id}` };
    if (frame.method === "session.interrupt" && ++interrupts === 1)
      return refusal("stale_generation", { execution_generation: 4 });
    return {};
  });
  const { key } = await sessions.create({ agentId });
  assert.deepEqual(await sessions.abort({ key }), {
    status: "not_interrupted",
    interrupted: false,
  });
  await sessions.send({ key, turn: { message: "a" }, idempotencyKey: "a" });
  await sessions.send({ key, turn: { message: "b" }, idempotencyKey: "b" });
  peer.send(
    event("message.start", "s1", {}, { admission_id: "ad-a", execution_generation: 3 }),
  );
  await settle();
  assert.deepEqual(await sessions.abort({ key, runId: "b" }), {
    status: "cancelled",
    interrupted: true,
  });
  assert.equal((await sessions.abort({ key, runId: "a" })).status, "interrupted");
  assert.deepEqual(
    peer.frames
      .filter((f) => /interrupt|cancel/.test(f.method))
      .map((f) => [f.method, f.params.execution_generation ?? f.params.admission_id]),
    [
      ["prompt.cancel", "ad-b"],
      ["session.interrupt", 3],
      ["session.interrupt", 4],
    ],
  );
});

test("describe reads the transcript; a deleted session is none", async () => {
  const { sessions } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "session.history")
      return frame.params.session_id === "s1"
        ? { count: 3, messages: [] }
        : refusal("not_found");
    return {};
  });
  const { key } = await sessions.create({ agentId, label: "Chat" });
  const { session } = await sessions.describe({ key });
  assert.deepEqual(
    [session.key, session.sessionId, session.label, session.messageCount, session.live],
    [key, "s1", "Chat", 3, true],
  );
  assert.deepEqual(await sessions.describe({ key: sessionKeyOf(agentId, "gone") }), {
    session: null,
  });
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
