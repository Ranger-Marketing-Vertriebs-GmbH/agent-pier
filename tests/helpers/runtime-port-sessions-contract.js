import test from "node:test";
import assert from "node:assert/strict";

/**
 * The sessions and events sub-ports of the runtime port contract
 * (runtime-port-contract.js): a session's life, a turn and the run events it sends,
 * and how both behave while the runtime is unreachable.
 */
export function sessionsContract(name, make, { kinds, tick }) {
  const agentId = "agent-1";
  const label = "AgentPier agent-1 chat";
  // Collects the run events until one of `runId` ends it.
  const runEvents = (runtime) => {
    const seen = [];
    const unsubscribe = runtime.events.subscribe((event) => seen.push(event));
    const ended = async (runId) => {
      for (let n = 0; n < 50; n++) {
        const own = seen.filter((e) => e.runId === runId);
        if (own.some((e) => ["finished", "aborted", "failed"].includes(e.kind)))
          return own;
        await tick();
      }
      assert.fail(`run ${runId} never ended`);
    };
    return { seen, unsubscribe, ended };
  };

  test(`${name}: sessions are created, listed, kept open and deleted`, async () => {
    const { sessions } = await make({});
    const { key } = await sessions.create({ agentId, label });
    assert.equal(typeof key, "string");
    assert.deepEqual(
      (await sessions.list({ agentId, label })).map((s) => s.key),
      [key],
    );
    assert.deepEqual(await sessions.list({ agentId, label: "another" }), []);
    const { session } = await sessions.describe({ key });
    assert.equal(typeof session.sessionId, "string");
    assert.equal(await sessions.keepOpen({ key }), "pinned");
    assert.equal(await sessions.keepOpen({ key }), "open");
    assert.equal(await sessions.keepOpen({ key: `${key}:gone` }), "missing");
    await sessions.subscribeMessages({ key });
    await sessions.delete({ key, deleteTranscript: true });
    assert.equal((await sessions.describe({ key }))?.session?.sessionId, undefined);
    assert.deepEqual(await sessions.list({ agentId, label }), []);
  });

  test(`${name}: a turn runs and sends normalized run events`, async () => {
    const runtime = await make({});
    const { sessions } = runtime;
    const { key } = await sessions.create({ agentId, label });
    const events = runEvents(runtime);
    const sent = await sessions.send({
      key,
      turn: { message: "Hello" },
      idempotencyKey: "run-1",
    });
    // The idempotency key names the run, so a lost acknowledgement stays traceable.
    assert.equal(sent.runId, "run-1");
    const own = await events.ended("run-1");
    assert.equal(own[0].kind, "started");
    assert.ok(own.some((e) => e.kind === "text"));
    assert.equal(own.at(-1).kind, "finished");
    for (const event of own) {
      assert.ok(kinds.includes(event.kind), event.kind);
      assert.equal(event.sessionKey, key);
      assert.equal(event.reason, null);
      assert.equal(typeof event.event, "string");
      assert.equal(typeof event.payload, "object");
    }
    const outcome = await sessions.wait({ runId: "run-1", waitMs: 1, timeoutMs: 3000 });
    assert.equal(outcome.status, "ok");
    const history = await sessions.history({ sessionKey: key, limit: 10 });
    assert.ok(history.messages.length > 0);
    await sessions.abort({ key, runId: "run-1" });
    await sessions.compact({ key, timeoutMs: 1000 });
    assert.ok(Array.isArray((await sessions.get({ key, limit: 5 })).messages));
    // After unsubscribe no event arrives.
    events.unsubscribe();
    const before = events.seen.length;
    await sessions.send({ key, turn: { message: "Again" }, idempotencyKey: "run-2" });
    for (let n = 0; n < 5; n++) await tick();
    assert.equal(events.seen.length, before);
  });

  test(`${name}: a view bound to a replaced connection reaches nothing`, async () => {
    const runtime = await make({});
    const before = runtime.host.connection();
    const bound = runtime.sessions.on(before);
    const { key } = await bound.create({ agentId, label });
    assert.equal((await bound.describe({ key })).session.sessionId.length > 0, true);
    await runtime.host.restart();
    const events = runEvents(runtime);
    const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
    await assert.rejects(
      bound.send({ key, turn: { message: "x" }, idempotencyKey: "late" }),
      unavailable,
    );
    await assert.rejects(bound.abort({ key, runId: "late" }), unavailable);
    await assert.rejects(bound.history({ sessionKey: key, limit: 1 }), unavailable);
    for (let n = 0; n < 5; n++) await tick();
    assert.deepEqual(events.seen, []);
    events.unsubscribe();
    // Bound to the new connection, calls go out again.
    const now = runtime.sessions.on(runtime.host.connection());
    assert.ok((await now.create({ agentId, label })).key);
  });

  test(`${name}: a failed run names its reason`, async () => {
    const runtime = await make({ runFailure: "timeout" });
    const { key } = await runtime.sessions.create({ agentId, label });
    const events = runEvents(runtime);
    await runtime.sessions.send({ key, turn: { message: "Hi" }, idempotencyKey: "r" });
    const last = (await events.ended("r")).at(-1);
    assert.equal(last.kind, "failed");
    assert.equal(last.reason, "timeout");
    events.unsubscribe();
    const outcome = await runtime.sessions.wait({ runId: "r", waitMs: 1, timeoutMs: 1 });
    assert.equal(outcome.status, "error");
  });

  test(`${name}: sessions reject and events stay quiet while unreachable`, async () => {
    const { sessions, events } = await make({ unreachable: true });
    const key = "agent:agent-1:x";
    const calls = {
      create: () => sessions.create({ agentId, label }, { budgetMs: 1 }),
      send: () => sessions.send({ key, turn: { message: "x" }, idempotencyKey: "r" }),
      abort: () => sessions.abort({ key, runId: "r" }),
      wait: () => sessions.wait({ runId: "r", waitMs: 1, timeoutMs: 1 }),
      describe: () => sessions.describe({ key }),
      list: () => sessions.list({ agentId, label }),
      get: () => sessions.get({ key, limit: 1, timeoutMs: 1 }),
      delete: () => sessions.delete({ key, deleteTranscript: true }),
      keepOpen: () => sessions.keepOpen({ key }),
      compact: () => sessions.compact({ key, timeoutMs: 1 }),
      subscribeMessages: () => sessions.subscribeMessages({ key }),
      history: () => sessions.history({ sessionKey: key, limit: 1 }),
      downloadArtifact: () =>
        sessions.downloadArtifact({ sessionKey: key, artifactId: "a", maxBytes: 1 }),
    };
    for (const [method, call] of Object.entries(calls)) {
      // A rejection, never a synchronous throw: callers await it inside try/catch.
      const pending = call();
      assert.ok(pending instanceof Promise, method);
      await assert.rejects(pending, method);
    }
    // A refused turn whose session cannot be reopened does not go again.
    const refusal = Object.assign(new Error("refused"), { code: "INVALID_REQUEST" });
    assert.equal(await sessions.reopenRefused({ key, error: refusal }), false);
    assert.equal(sessions.notCreated(new Error("plain")), false);
    const unsubscribe = events.subscribe(() => assert.fail("no event"));
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
  });
}

/**
 * Sessions and events held in memory for the fake runtime: runs end on the next
 * turns of the event loop, finished or failed with `runFailure`. Every call goes
 * through `reach`, which rejects while the runtime is unreachable.
 */
export function fakeSessionPorts({ reach, runFailure = null, connection }) {
  const connected = () => connection() !== null;
  const sessions = new Map();
  const runs = new Map();
  const listeners = new Set();
  let created = 0;
  const emit = (kind, sessionKey, runId, reason = null) => {
    if (!connected()) return;
    const event = { kind, sessionKey, runId, reason, event: "run", payload: { kind } };
    for (const listener of listeners) listener(event);
  };
  const run = async (key, runId) => {
    const pause = () => new Promise((resolve) => setImmediate(resolve));
    for (const kind of ["started", "text"]) {
      await pause();
      emit(kind, key, runId);
    }
    await pause();
    runs.set(runId, runFailure ? "error" : "ok");
    if (runFailure) emit("failed", key, runId, runFailure);
    else emit("finished", key, runId);
  };
  const session = (key) => sessions.get(key);
  const methods = {
    create: ({ agentId, label }) =>
      reach(() => {
        const key = `agent:${agentId}:fake:${++created}`;
        sessions.set(key, {
          key,
          agentId,
          label,
          sessionId: `s${created}`,
          messages: [],
        });
        return { key };
      }),
    notCreated: () => false,
    send: ({ key, turn, idempotencyKey }) =>
      reach(() => {
        session(key)?.messages.push({ role: "user", text: turn.message });
        runs.set(idempotencyKey, "running");
        run(key, idempotencyKey);
        return { runId: idempotencyKey };
      }),
    abort: () => reach(() => ({ ok: true })),
    wait: ({ runId }) => reach(() => ({ runId, status: runs.get(runId) || "timeout" })),
    describe: ({ key }) =>
      reach(() => ({ session: session(key) && { ...session(key) } })),
    list: ({ agentId, label }) =>
      reach(() =>
        [...sessions.values()].filter((s) => s.agentId === agentId && s.label === label),
      ),
    get: ({ key }) => reach(() => ({ messages: [...(session(key)?.messages || [])] })),
    delete: ({ key }) => reach(() => sessions.delete(key) && { ok: true }),
    keepOpen: ({ key }) =>
      reach(() => {
        const s = session(key);
        if (!s) return "missing";
        if (s.pinned) return "open";
        s.pinned = true;
        return "pinned";
      }),
    reopenRefused: async () => false,
    compact: () => reach(() => ({ ok: true })),
    subscribeMessages: () => reach(() => ({})),
    history: ({ sessionKey }) =>
      reach(() => ({ messages: [...(session(sessionKey)?.messages || [])] })),
    downloadArtifact: () =>
      reach(() => {
        throw Object.assign(new Error("Artifact gone."), { artifactRefusal: "gone" });
      }),
  };
  // A view bound to one connection refuses every call once another replaced it.
  const closed = () =>
    Promise.reject(
      Object.assign(new Error("closed"), { code: "UNAVAILABLE", status: 503 }),
    );
  const on = (bound) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(methods).map(([name, method]) => [
          name,
          ["notCreated", "reopenRefused"].includes(name)
            ? method
            : (...args) => (bound && bound === connection() ? method(...args) : closed()),
        ]),
      ),
    );
  return {
    sessions: { ...methods, on },
    events: {
      subscribe(listener) {
        if (!connected()) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}
