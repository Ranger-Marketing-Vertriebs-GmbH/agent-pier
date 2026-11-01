import test from "node:test";
import assert from "node:assert/strict";
import { hermesApprovals } from "../../server/features/assistants/runtimes/hermes/hermes-approvals.js";
import { agentId, event, scripted, settle } from "../helpers/hermes-scripted.js";

const snapshot = (prompts = []) => ({
  session_id: "s1",
  stored_session_id: "s1",
  revision: 0,
  execution_generation: 1,
  subscription_id: "sub-1",
  prompts,
});
const prompt = (id, extra = {}) => ({
  kind: "approval",
  prompt_id: id,
  execution_generation: 1,
  command: "rm -rf build",
  description: "recursive delete",
  choices: ["once", "deny", "session", "always"],
  timeout_s: 300,
  ...extra,
});
// The gateway's announcement of a question, as a turn's frame.
const asking = (id, extra) =>
  event("approval.request", "s1", prompt(id, extra), {
    admission_id: "ad1",
    execution_generation: 1,
  });

test("an approval request becomes an exec approval and its answer goes back", async () => {
  const { peer, sessions, events, approvals } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "prompt.submit") return { admission_id: "ad1" };
    if (frame.method === "approval.respond") {
      // Hermes announces the answer before it acknowledges it.
      peer.send(event("approval.settled", "s1", { prompt_id: frame.params.prompt_id }));
      return { status: "resolved", prompt_id: frame.params.prompt_id };
    }
    return {};
  });
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({
    key,
    turn: { message: "RUN: rm -rf build" },
    idempotencyKey: "run-1",
  });
  peer.send(asking("p1"));
  await settle();
  const requested = seen.find((e) => e.kind === "approval.requested");
  assert.equal(requested.event, "exec.approval.requested");
  assert.equal(requested.sessionKey, key);
  assert.equal(requested.runId, "run-1");
  const { payload } = requested;
  assert.equal(payload.id, "p1");
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
  assert.deepEqual(
    (await approvals.list()).map((i) => i.id),
    ["p1"],
  );
  await assert.rejects(
    approvals.resolve({ id: "p1", decision: "allow-always" }),
    (e) => e.answered === true && e.code === "INVALID_REQUEST",
  );
  await approvals.resolve({ id: "p1", decision: "allow-once" });
  assert.deepEqual(peer.frames.at(-1).params, {
    session_id: "s1",
    execution_generation: 1,
    prompt_id: "p1",
    choice: "once",
  });
  await settle();
  const resolved = seen.filter((e) => e.kind === "approval.resolved");
  assert.deepEqual(
    resolved.map((e) => [e.payload.id, e.payload.decision, e.payload.resolvedBy]),
    [["p1", "allow-once", "owner"]],
  );
  peer.send(asking("p2"));
  await settle();
  await approvals.resolve({ id: "p2", decision: "allow-session" });
  assert.equal(peer.frames.at(-1).params.choice, "session");
  assert.deepEqual(
    (await approvals.history()).items.map((i) => [i.id, i.status, i.decision]),
    [
      ["p1", "allowed", "allow-once"],
      ["p2", "allowed", "allow-session"],
    ],
  );
  await assert.rejects(
    approvals.resolve({ id: "p1", decision: "deny" }),
    (e) => e.answered === true,
  );
});

test("an approval settled elsewhere or dropped ends without a decision", async () => {
  const { client, peer, events, approvals } = await scripted((frame) =>
    frame.method === "approval.respond"
      ? { status: "already_resolved", prompt_id: frame.params.prompt_id }
      : {},
  );
  const seen = [];
  events.subscribe((e) => seen.push(e));
  peer.send(asking("p1", { choices: ["once", "deny"] }));
  peer.send(asking("p2"));
  peer.send(asking("p3"));
  peer.send(asking("p4"));
  await settle();
  assert.deepEqual((await approvals.list())[0].request.allowedDecisions, [
    "allow-once",
    "deny",
  ]);
  peer.send(event("approval.settled", "s1", { prompt_id: "p1" }));
  peer.send(
    event("approval.cancelled", "s1", { reason: "interrupt", request_ids: ["p2", "p9"] }),
  );
  await settle();
  // Answered too late: another viewer or Hermes's timeout came first.
  await assert.rejects(
    approvals.resolve({ id: "p3", decision: "deny" }),
    (e) => e.answered === true,
  );
  assert.deepEqual(
    (await approvals.history()).items.map((i) => [
      i.id,
      i.status,
      i.decision,
      i.resolvedBy,
    ]),
    [
      ["p1", "cancelled", null, "hermes"],
      ["p2", "cancelled", null, "interrupt"],
      ["p3", "cancelled", null, "hermes"],
    ],
  );
  assert.deepEqual(
    seen.filter((e) => e.kind === "approval.resolved").map((e) => e.payload.decision),
    [null, null, null],
  );
  // A request announced again is not asked twice.
  peer.send(asking("p4"));
  await settle();
  assert.equal(seen.filter((e) => e.kind === "approval.requested").length, 4);
  const bound = hermesApprovals({ client }).on(null);
  await assert.rejects(bound.list(), (e) => e.code === "UNAVAILABLE");
  client.close();
  await assert.rejects(
    approvals.resolve({ id: "p4", decision: "deny" }),
    (e) => e.code === "UNAVAILABLE" && e.status === 503,
  );
  assert.deepEqual(approvals.allowAlwaysPlan({ command: "rm -rf x" }), {
    kind: "once",
    reason: "pattern",
  });
});

test("a session attached again asks what still waits, questions too", async () => {
  const { peer, sessions, approvals, events } = await scripted((frame) => {
    if (frame.method === "session.resume")
      return snapshot([
        prompt("p1"),
        { kind: "clarify", prompt_id: "c1", execution_generation: 1, question: "Which?" },
      ]);
    if (frame.method === "prompt.submit") return { admission_id: "ad1" };
    return {};
  });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.subscribeMessages({ key: `agent:${agentId}:hermes:s1` });
  await settle();
  assert.deepEqual(
    (await approvals.list()).map((i) => [i.id, i.request.sessionKey]),
    [["p1", `agent:${agentId}:hermes:s1`]],
  );
  // The clarify question waits for the owner instead of an empty answer.
  assert.deepEqual(
    (await approvals.questions()).map((q) => [q.id, q.request.question]),
    [["c1", "Which?"]],
  );
  assert.equal(seen.find((e) => e.event === "question.requested").kind, "other");
  assert.equal(peer.frames.filter((f) => f.method === "clarify.respond").length, 0);
});

test("a clarify question is answered by the owner; settled and cancelled ones end", async () => {
  const { peer, sessions, approvals, events } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "prompt.submit") return { admission_id: "ad1" };
    if (frame.method === "clarify.respond") {
      peer.send(event("clarify.settled", "s1", { prompt_id: frame.params.prompt_id }));
      return { status: "resolved", prompt_id: frame.params.prompt_id };
    }
    return {};
  });
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({ key, turn: { message: "plan it" }, idempotencyKey: "run-1" });
  const ask = (id, extra = {}) =>
    peer.send(
      event(
        "clarify.request",
        "s1",
        {
          kind: "clarify",
          prompt_id: id,
          execution_generation: 1,
          question: "Which stage?",
          choices: ["staging", "prod"],
          multi_select: false,
          timeout_s: 600,
          ...extra,
        },
        { admission_id: "ad1" },
      ),
    );
  ask("c1");
  await settle();
  const requested = seen.find((e) => e.event === "question.requested");
  assert.equal(requested.sessionKey, key);
  assert.equal(requested.runId, "run-1");
  assert.deepEqual(
    { ...requested.payload.request, hermes: undefined },
    {
      question: "Which stage?",
      choices: ["staging", "prod"],
      multiSelect: false,
      agentId,
      sessionKey: key,
      runId: "run-1",
      hermes: undefined,
    },
  );
  assert.equal(requested.payload.expiresAtMs - requested.payload.createdAtMs, 600000);
  // The run waits for the owner meanwhile.
  assert.ok(seen.some((e) => e.step?.phase === "waiting-approval"));
  await assert.rejects(approvals.answer({ id: "c1", answer: " " }), (e) => e.answered);
  await approvals.answer({ id: "c1", answer: "prod" });
  assert.deepEqual(peer.frames.find((f) => f.method === "clarify.respond").params, {
    session_id: "s1",
    execution_generation: 1,
    prompt_id: "c1",
    answer: "prod",
  });
  const ended = (id) =>
    seen.find((e) => e.event === "question.resolved" && e.payload.id === id)?.payload
      .status;
  assert.equal(ended("c1"), "answered");
  assert.deepEqual(await approvals.questions(), []);
  await assert.rejects(approvals.answer({ id: "c1", answer: "prod" }), (e) => e.answered);
  // Answered elsewhere or withdrawn by an interrupt.
  ask("c2");
  ask("c3");
  await settle();
  peer.send(event("clarify.settled", "s1", { prompt_id: "c2" }));
  peer.send(
    event("approval.cancelled", "s1", { request_ids: ["c3"], reason: "interrupt" }),
  );
  await settle();
  assert.equal(ended("c2"), "cancelled");
  assert.equal(ended("c3"), "cancelled");
  assert.deepEqual(await approvals.questions(), []);
});

test("sudo and secret requests are declined at once; other requests fail fast", async () => {
  const { peer } = await scripted();
  for (const [id, method] of [
    ["srq-s", "secret"],
    ["srq-u", "sudo"],
    ["srq-t", "theme.pick"],
  ])
    peer.send({ jsonrpc: "2.0", id, method, params: { session_id: "s1" } });
  await settle();
  const answer = (id) => peer.frames.find((f) => f.id === id);
  // Hermes's own "declined": an empty value, never a password or a secret.
  assert.deepEqual(answer("srq-s").result, { value: "" });
  assert.deepEqual(answer("srq-u").result, { value: "" });
  assert.equal(answer("srq-t").error.code, -32601);
});
