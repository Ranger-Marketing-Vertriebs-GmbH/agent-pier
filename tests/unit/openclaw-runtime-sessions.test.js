import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { openClawRunEvent } from "../../server/features/assistants/runtimes/openclaw/openclaw-events.js";
import { RUN_EVENT_KINDS } from "../../server/features/assistants/runtimes/agent-runtime.js";
import { hostConnection } from "../../server/features/assistants/runtimes/runtime-for.js";

// A client that records each call as [method, params, options?] and answers `answer`.
function recorder(answer = () => ({})) {
  const calls = [];
  return {
    calls,
    ready: true,
    async call(method, ...rest) {
      calls.push([method, ...rest]);
      return answer(method, rest[0]);
    },
  };
}

test("the sessions sub-port sends the Gateway requests callers sent before the port", async () => {
  const client = recorder((method) =>
    method === "sessions.list" ? { sessions: [] } : { key: "agent:a:x", runId: "r" },
  );
  const { sessions } = createOpenClawRuntime({ client });
  const onLate = () => {};
  await sessions.create({ agentId: "a", label: "L" }, { budgetMs: 60000 });
  await sessions.send({
    key: "k",
    turn: { message: "hi", attachments: [] },
    idempotencyKey: "i",
    onLate,
  });
  await sessions.abort({ key: "k", runId: "r" });
  await sessions.wait({ runId: "r", waitMs: 1, timeoutMs: 3000 });
  await sessions.describe({ key: "k" });
  await sessions.list({ agentId: "a", label: "L" });
  await sessions.get({ key: "k", limit: 20, timeoutMs: 5000 });
  await sessions.delete({ key: "k", deleteTranscript: true });
  await sessions.compact({ key: "k", timeoutMs: 600000 });
  await sessions.subscribeMessages({ key: "k" });
  await sessions.history({ sessionKey: "k", limit: 100, offset: 0 });
  await sessions.history({ sessionKey: "k", messageId: "m", limit: 1, maxChars: 9 });
  assert.deepEqual(client.calls, [
    ["sessions.create", { agentId: "a", label: "L" }, { timeoutMs: 60000 }],
    [
      "sessions.send",
      { key: "k", message: "hi", attachments: [], idempotencyKey: "i" },
      { onLate },
    ],
    ["sessions.abort", { key: "k", runId: "r" }],
    ["agent.wait", { runId: "r", timeoutMs: 1 }, { timeoutMs: 3000 }],
    ["sessions.describe", { key: "k" }],
    ["sessions.list", {}],
    ["sessions.get", { key: "k", limit: 20 }, { timeoutMs: 5000 }],
    ["sessions.delete", { key: "k", deleteTranscript: true }],
    ["sessions.compact", { key: "k" }, { timeoutMs: 600000 }],
    ["sessions.messages.subscribe", { key: "k" }],
    ["chat.history", { sessionKey: "k", limit: 100, offset: 0 }],
    ["chat.history", { sessionKey: "k", messageId: "m", limit: 1, maxChars: 9 }],
  ]);
});

test("sessions.list finds an agent's sessions by label, by agent id or key prefix", async () => {
  const listed = [
    { key: "agent:a:1", label: "L" },
    { key: "agent:b:2", label: "L", agentId: "a" },
    { key: "agent:ab:3", label: "L" },
    { key: "agent:a:4", label: "M" },
  ];
  const client = recorder(() => ({ sessions: listed }));
  const { sessions } = createOpenClawRuntime({ client });
  assert.deepEqual(
    (await sessions.list({ agentId: "a", label: "L" })).map((s) => s.key),
    ["agent:a:1", "agent:b:2"],
  );
  const empty = createOpenClawRuntime({ client: recorder(() => ({})) });
  assert.deepEqual(await empty.sessions.list({ agentId: "a", label: "L" }), []);
});

test("sessions.keepOpen pins, reopens and reports a missing session", async () => {
  let session = { sessionId: "s1", archived: true };
  const client = recorder((method) =>
    method === "sessions.describe" ? { session } : {},
  );
  const { sessions } = createOpenClawRuntime({ client });
  assert.equal(await sessions.keepOpen({ key: "k" }), "reopened");
  session = { sessionId: "s1" };
  assert.equal(await sessions.keepOpen({ key: "k" }), "pinned");
  session = { sessionId: "s1", pinned: true };
  assert.equal(await sessions.keepOpen({ key: "k" }), "open");
  session = undefined;
  assert.equal(await sessions.keepOpen({ key: "k" }), "missing");
  // A refused turn goes again only once its archived session reopened.
  session = { sessionId: "s1", archived: true };
  const refused = Object.assign(new Error("x"), { code: "INVALID_REQUEST" });
  assert.equal(await sessions.reopenRefused({ key: "k", error: refused }), true);
  assert.equal(await sessions.reopenRefused({ key: "k", error: new Error("x") }), false);
});

test("downloadArtifact reads the located file and names a lasting refusal", async () => {
  const located = { url: "/api/chat/media/outgoing/ticket" };
  const client = {
    calls: [],
    async call(...args) {
      client.calls.push(args);
      return client.answer();
    },
    async download(url, options) {
      client.calls.push(["download", url, options]);
      if (client.tooLarge) throw Object.assign(new Error("big"), { tooLarge: true });
      return { body: Buffer.from("png") };
    },
    answer: () => located,
  };
  const { sessions } = createOpenClawRuntime({ client });
  const request = { sessionKey: "k", artifactId: "a", maxBytes: 10, timeoutMs: 30000 };
  const { body } = await sessions.downloadArtifact(request);
  assert.equal(body.toString(), "png");
  assert.deepEqual(client.calls, [
    ["artifacts.download", { sessionKey: "k", artifactId: "a" }, { timeoutMs: 30000 }],
    ["download", located.url, { maxBytes: 10 }],
  ]);
  const refusal = (reason) => (error) => error.artifactRefusal === reason;
  client.tooLarge = true;
  await assert.rejects(sessions.downloadArtifact(request), refusal("size"));
  client.answer = () => ({ url: "https://elsewhere/x" });
  await assert.rejects(sessions.downloadArtifact(request), refusal("location"));
  client.answer = () => {
    throw Object.assign(new Error("Artifact not found"), { answered: true, code: "X" });
  };
  await assert.rejects(sessions.downloadArtifact(request), refusal("gone"));
  // An unanswered failure may pass on a retry.
  client.answer = () => {
    throw Object.assign(new Error("Artifact not found"), { code: "TIMEOUT" });
  };
  await assert.rejects(
    sessions.downloadArtifact(request),
    (error) => error.code === "TIMEOUT" && !error.artifactRefusal,
  );
});

test("OpenClaw frames read as normalized run events with the frame alongside", () => {
  const cases = [
    [{ event: "chat", payload: { state: "delta" } }, "text"],
    [{ event: "chat", payload: { state: "final" } }, "finished"],
    [{ event: "chat", payload: { state: "aborted" } }, "aborted"],
    [{ event: "chat", payload: { state: "error", errorKind: "timeout" } }, "failed"],
    [{ event: "chat", payload: { state: "other" } }, "progress"],
    [
      { event: "agent", payload: { stream: "lifecycle", data: { phase: "start" } } },
      "started",
    ],
    [{ event: "agent", payload: { stream: "item", data: { kind: "tool" } } }, "tool"],
    [{ event: "agent", payload: { stream: "thinking", data: {} } }, "progress"],
    [{ event: "exec.approval.requested", payload: { id: "e" } }, "approval.requested"],
    [{ event: "exec.approval.resolved", payload: { id: "e" } }, "approval.resolved"],
    [{ event: "skills.changed", payload: {} }, "other"],
  ];
  const steps = {
    lifecycle: { type: "lifecycle", phase: "start" },
    thinking: { type: "thinking" },
  };
  for (const [frame, kind] of cases) {
    const payload = { ...frame.payload, sessionKey: "agent:a:1", runId: "r" };
    const event = openClawRunEvent({ ...frame, payload });
    assert.ok(RUN_EVENT_KINDS.includes(event.kind), kind);
    assert.deepEqual(event, {
      kind,
      sessionKey: "agent:a:1",
      runId: "r",
      reason: kind === "failed" ? "timeout" : null,
      // A chat frame without text places no reply; an agent frame names its step.
      reply:
        frame.event === "chat"
          ? { text: undefined, delta: undefined, replace: false }
          : null,
      step: steps[frame.payload.stream] ?? null,
      event: frame.event,
      payload,
    });
  }
  // A frame without a session or run names neither.
  const bare = openClawRunEvent({ event: "health" });
  assert.deepEqual([bare.kind, bare.sessionKey, bare.runId], ["other", null, null]);
  // A failure without a kind has no reason.
  assert.equal(
    openClawRunEvent({ event: "chat", payload: { state: "error" } }).reason,
    null,
  );
});

test("events follow the client of the moment they are subscribed on", () => {
  const subscribers = (client) => {
    const listeners = new Set();
    return Object.assign(client, {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (frame) => listeners.forEach((listener) => listener(frame)),
    });
  };
  const supervisor = { client: subscribers({}) };
  const { events } = createOpenClawRuntime(supervisor);
  const seen = [];
  const unsubscribe = events.subscribe((event) => seen.push(event.kind));
  const first = supervisor.client;
  supervisor.client = subscribers({});
  // The new connection is not heard until callers subscribe again.
  supervisor.client.emit({ event: "chat", payload: { state: "final" } });
  first.emit({ event: "chat", payload: { state: "delta" } });
  unsubscribe();
  first.emit({ event: "chat", payload: { state: "final" } });
  assert.deepEqual(seen, ["text"]);
  supervisor.client = null;
  assert.equal(typeof events.subscribe(() => {}), "function");
});

test("host.connection() is one handle per client, shared by every adapter", () => {
  const client = { ready: true };
  const supervisor = { client };
  const handle = createOpenClawRuntime(supervisor).host.connection();
  assert.ok(Object.isFrozen(handle));
  assert.equal(createOpenClawRuntime({ client }).host.connection(), handle);
  assert.equal(hostConnection(supervisor), handle);
  supervisor.client = { ready: true };
  assert.notEqual(hostConnection(supervisor), handle);
  supervisor.client = null;
  assert.equal(hostConnection(supervisor), null);
  assert.equal(hostConnection(undefined), null);
});

test("sessions.on(connection) reaches only the client it captured", async () => {
  // The client the supervisor replaced and closed (runtime-supervisor.js launch/stop).
  const old = new GatewayClient({
    url: "wss://127.0.0.1:1",
    token: "t",
    certPath: "/nonexistent",
  });
  const supervisor = { client: old };
  const runtime = createOpenClawRuntime(supervisor);
  const bound = runtime.sessions.on(runtime.host.connection());
  const fresh = recorder();
  supervisor.client = fresh;
  old.close();
  // Rejects as a call on the old, closed client always did; the new one sees nothing.
  const closed = await old
    .call("sessions.abort", { key: "k", runId: "r" })
    .catch((e) => e);
  for (const pending of [
    bound.abort({ key: "k", runId: "r" }),
    bound.send({ key: "k", turn: { message: "x" }, idempotencyKey: "i" }),
    bound.compact({ key: "k", timeoutMs: 1 }),
    bound.delete({ key: "k", deleteTranscript: true }),
    bound.subscribeMessages({ key: "k" }),
    bound.history({ sessionKey: "k", limit: 1 }),
    bound.get({ key: "k", limit: 1, timeoutMs: 1 }),
    bound.keepOpen({ key: "k" }),
    bound.create({ agentId: "a", label: "L" }),
  ]) {
    const error = await pending.catch((e) => e);
    assert.deepEqual(
      [error.code, error.status, error.message],
      [closed.code, closed.status, closed.message],
    );
  }
  assert.deepEqual([closed.code, closed.status], ["UNAVAILABLE", 503]);
  assert.equal(await bound.reopenRefused({ key: "k", error: new Error("x") }), false);
  assert.deepEqual(fresh.calls, []);
  // Bound to the current connection, a view uses the current client.
  await runtime.sessions.on(runtime.host.connection()).abort({ key: "k", runId: "r" });
  assert.deepEqual(fresh.calls, [["sessions.abort", { key: "k", runId: "r" }]]);
  // Captured while there was no client: it rejects as the missing client did.
  supervisor.client = null;
  const none = runtime.sessions.on(runtime.host.connection());
  supervisor.client = fresh;
  await assert.rejects(none.abort({ key: "k", runId: "r" }), TypeError);
  assert.equal(fresh.calls.length, 1);
  assert.ok(Object.isFrozen(bound));
  assert.equal(bound.on, undefined);
});
