import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";

// A client that records each call as [method, params] and answers `answer`.
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
const unavailable = (error) => error.status === 503 && error.key === "unavailable";

test("the routines sub-port sends the Gateway requests callers sent before the port", async () => {
  const client = recorder((method) =>
    method === "cron.list" ? { jobs: [], hasMore: false } : {},
  );
  const { routines } = createOpenClawRuntime({ client });
  const routine = { name: "Inbox", agentId: "ap-1", enabled: true, wakeNow: true };
  const job = { name: "Inbox", agentId: "ap-1", enabled: true, wakeMode: "now" };
  await routines.list({ agentId: "ap-1" });
  await routines.list();
  await routines.add({ routine });
  await routines.update({ id: "j1", patch: { enabled: false } });
  await routines.remove({ id: "j1" });
  await routines.run({ id: "j1", force: true });
  await routines.run({ id: "j1" });
  await routines.runs({ id: "j1", limit: 20 });
  await routines.status();
  const list = { includeDisabled: true, limit: 200, offset: 0 };
  assert.deepEqual(client.calls, [
    ["cron.list", { agentId: "ap-1", ...list }],
    ["cron.list", list],
    ["cron.add", job],
    ["cron.update", { id: "j1", patch: { enabled: false } }],
    ["cron.remove", { id: "j1" }],
    ["cron.run", { id: "j1", mode: "force" }],
    ["cron.run", { id: "j1" }],
    ["cron.runs", { id: "j1", limit: 20 }],
    ["cron.status", {}],
  ]);
});

test("list pages through cron.list and refuses a listing it cannot page", async () => {
  const pages = {
    0: { jobs: [{ id: "a" }], hasMore: true, nextOffset: 1 },
    1: { jobs: [{ id: "b" }], hasMore: false },
  };
  const client = recorder((method, { offset }) => pages[offset]);
  const { routines } = createOpenClawRuntime({ client });
  assert.deepEqual(
    (await routines.list({ agentId: "ap-1" })).map((j) => j.id),
    ["a", "b"],
  );
  assert.deepEqual(
    client.calls.map(([, params]) => params.offset),
    [0, 1],
  );
  for (const page of [
    { jobs: null },
    { jobs: [], hasMore: true, nextOffset: 0 },
    { jobs: [], hasMore: true },
  ]) {
    const broken = createOpenClawRuntime({ client: recorder(() => page) });
    await assert.rejects(broken.routines.list({ agentId: "ap-1" }), unavailable);
  }
  // At most 10000 jobs: a listing that keeps going is refused.
  const endless = recorder((method, { offset }) => ({
    jobs: Array.from({ length: 200 }, (_, i) => ({ id: `j${offset + i}` })),
    hasMore: true,
    nextOffset: offset + 200,
  }));
  await assert.rejects(
    createOpenClawRuntime({ client: endless }).routines.list(),
    unavailable,
  );
  assert.equal(endless.calls.length, 50);
});

test("add answers the created job, bare or wrapped, and run its outcome", async () => {
  const answers = [{ job: { id: "j1" } }, { id: "j2" }, null];
  const { routines } = createOpenClawRuntime({
    client: recorder(() => answers.shift()),
  });
  const ids = async () => (await routines.add({ routine: {} }))?.id ?? null;
  assert.equal(await ids(), "j1");
  assert.equal(await ids(), "j2");
  assert.equal(await ids(), null);
  const outcomes = [
    [
      { ok: true, enqueued: true },
      { queued: true, refused: false },
    ],
    [
      { ok: true, ran: false, reason: "not-due" },
      { queued: false, refused: true },
    ],
    [{ ok: true }, { queued: false, refused: false }],
    [undefined, { queued: false, refused: false }],
  ];
  for (const [answer, outcome] of outcomes) {
    const runtime = createOpenClawRuntime({ client: recorder(() => answer) });
    assert.deepEqual(await runtime.routines.run({ id: "j1", force: true }), outcome);
  }
});

test("a routines view reaches only the client it captured", async () => {
  // The client the supervisor replaced and closed (runtime-supervisor.js launch/stop).
  const old = new GatewayClient({
    url: "wss://127.0.0.1:1",
    token: "t",
    certPath: "/nonexistent",
  });
  const supervisor = { client: old };
  const runtime = createOpenClawRuntime(supervisor);
  const bound = runtime.routines.on(runtime.host.connection());
  const fresh = recorder(() => ({ jobs: [], hasMore: false }));
  supervisor.client = fresh;
  old.close();
  const closed = await old.call("cron.status", {}).catch((e) => e);
  for (const pending of [
    bound.list({ agentId: "ap-1" }),
    bound.add({ routine: {} }),
    bound.update({ id: "j1", patch: { enabled: true } }),
    bound.remove({ id: "j1" }),
    bound.run({ id: "j1", force: true }),
    bound.runs({ id: "j1", limit: 20 }),
    bound.status(),
  ]) {
    const error = await pending.catch((e) => e);
    assert.deepEqual(
      [error.code, error.status, error.message],
      [closed.code, closed.status, closed.message],
    );
  }
  assert.deepEqual(fresh.calls, []);
  assert.ok(Object.isFrozen(bound));
  assert.equal(bound.on, undefined);
  await runtime.routines.on(runtime.host.connection()).status();
  assert.deepEqual(fresh.calls, [["cron.status", {}]]);
});

// A job as OpenClaw lists it, with fields AgentPier never sets.
const listedJob = {
  id: "j1",
  name: "Meal plan",
  declarationKey: "agentpier-reminder:b1",
  agentId: "ap-1",
  enabled: true,
  deleteAfterRun: false,
  updatedAtMs: 7,
  createdAtMs: 1,
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin", staggerMs: 0 },
  wakeMode: "now",
  failureAlert: false,
  sessionTarget: "current",
  sessionKey: "agent:ap-1:main",
  payload: {
    kind: "agentTurn",
    message: "Plan",
    model: "openai/gpt",
    timeoutSeconds: 300,
    lightContext: false,
    toolsAllow: ["read"],
    thinking: "low",
  },
  delivery: {
    mode: "announce",
    completionDestination: { mode: "webhook", to: "http://127.0.0.1:1/complete/b1" },
  },
  state: {
    nextRunAtMs: 10,
    runningAtMs: 9,
    lastRunAtMs: 8,
    lastRunStatus: "error",
    lastStatus: "error",
    lastDeliveryStatus: "not-delivered",
    lastError: "boom",
    lastErrorReason: "timeout",
    consecutiveErrors: 2,
  },
};
const listedRoutine = {
  id: "j1",
  name: "Meal plan",
  agentId: "ap-1",
  enabled: true,
  revision: 7,
  keepAfterRun: true,
  wakeNow: true,
  alertOnFailure: false,
  marker: "agentpier-reminder:b1",
  schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" },
  target: { kind: "chat", sessionKey: "agent:ap-1:main" },
  prompt: {
    text: "Plan",
    model: "openai/gpt",
    timeoutSeconds: 300,
    fullContext: true,
    tools: ["read"],
  },
  delivery: { kind: "chat", url: "http://127.0.0.1:1/complete/b1" },
  runState: {
    nextRunAtMs: 10,
    runningAtMs: 9,
    lastRunAtMs: 8,
    lastStatus: "error",
    lastDeliveryStatus: "not-delivered",
    lastError: "boom",
    lastErrorReason: "timeout",
    failuresInRow: 2,
  },
};

test("listed jobs read back as AgentPier's routines", async () => {
  const client = recorder(() => ({
    jobs: [
      listedJob,
      // An agent's own job: no marker, a system event, an interval.
      {
        id: "own",
        agentId: "ap-1",
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "Stretch." },
        delivery: { mode: "none" },
      },
      {
        id: "r",
        schedule: { kind: "at", at: "2099-01-01T08:00:00.000Z" },
        sessionTarget: "isolated",
        delivery: { mode: "webhook", to: "http://x/complete/r" },
      },
      { id: "odd", schedule: { kind: "later" }, sessionTarget: "session:x" },
    ],
    hasMore: false,
  }));
  const [first, own, reminder, odd] = await createOpenClawRuntime({
    client,
  }).routines.list();
  assert.deepEqual(first, listedRoutine);
  assert.deepEqual(own, {
    id: "own",
    agentId: "ap-1",
    marker: null,
    schedule: { kind: "every", everyMs: 60000 },
    target: { kind: "main" },
    prompt: null,
    delivery: { kind: "none" },
    runState: {},
  });
  assert.deepEqual(
    [reminder.schedule, reminder.target, reminder.delivery],
    [
      { kind: "at", at: "2099-01-01T08:00:00.000Z" },
      { kind: "own" },
      { kind: "webhook", url: "http://x/complete/r" },
    ],
  );
  assert.deepEqual(
    [odd.schedule, odd.target, odd.delivery, odd.enabled],
    [null, { kind: "other" }, null, undefined],
  );
});

test("a routine is submitted as the cron job it reads back from", async () => {
  const client = recorder(() => ({}));
  const { routines } = createOpenClawRuntime({ client });
  const id = "j1";
  const definition = Object.fromEntries(
    Object.entries(listedRoutine).filter(
      ([key]) => !["id", "revision", "runState"].includes(key),
    ),
  );
  await routines.add({ routine: definition });
  await routines.update({ id, patch: { prompt: definition.prompt, enabled: false } });
  await routines.update({
    id,
    patch: {
      target: { kind: "own" },
      delivery: { kind: "webhook", url: "http://x" },
      schedule: { kind: "at", at: "2099-01-01T08:00:00.000Z" },
    },
  });
  await routines.update({ id, patch: { delivery: { kind: "none" }, wakeNow: false } });
  // The listed job without what OpenClaw added itself.
  const payload = { ...listedJob.payload };
  delete payload.thinking;
  const job = {
    ...listedJob,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
    payload,
  };
  for (const key of ["id", "updatedAtMs", "createdAtMs", "state"]) delete job[key];
  assert.deepEqual(client.calls, [
    ["cron.add", job],
    ["cron.update", { id, patch: { payload, enabled: false } }],
    [
      "cron.update",
      {
        id,
        patch: {
          sessionTarget: "isolated",
          delivery: { mode: "webhook", to: "http://x" },
          schedule: { kind: "at", at: "2099-01-01T08:00:00.000Z" },
        },
      },
    ],
    [
      "cron.update",
      { id, patch: { delivery: { mode: "none" }, wakeMode: "next-heartbeat" } },
    ],
  ]);
});

test("run records and run sessions are AgentPier's", async () => {
  const entry = {
    ts: 5,
    jobId: "j1",
    action: "finished",
    runAtMs: 4,
    status: "error",
    error: "boom",
    errorReason: "timeout",
    durationMs: 3,
    deliveryStatus: "not-delivered",
    sessionId: "s1",
    sessionKey: "agent:ap-1:cron:j1:run:s1",
    summary: "never",
  };
  const runtime = createOpenClawRuntime({
    client: recorder(() => ({ entries: [entry] })),
  });
  assert.deepEqual(await runtime.routines.runs({ id: "j1", limit: 20 }), {
    entries: [
      {
        runAtMs: 4,
        status: "error",
        deliveryStatus: "not-delivered",
        durationMs: 3,
        error: "boom",
        errorReason: "timeout",
        sessionKey: "agent:ap-1:cron:j1:run:s1",
      },
    ],
  });
  const { runOf } = runtime.routines;
  assert.deepEqual(runOf("agent:ap-1:cron:j1:run:s1"), {
    agentId: "ap-1",
    routineId: "j1",
    runId: "s1",
    routineSession: "agent:ap-1:cron:j1",
  });
  assert.deepEqual(runOf("AGENT:ap-1:CRON:j1"), {
    agentId: "ap-1",
    routineId: "j1",
    runId: null,
    routineSession: "AGENT:ap-1:CRON:j1",
  });
  for (const key of ["agent:ap-1:main", "agent:ap-1:cron:j1:run:s1:x", null, 3])
    assert.equal(runOf(key), null);
  // A bound view tells run sessions apart too.
  const bound = runtime.routines.on(runtime.host.connection());
  assert.deepEqual(bound.runOf("agent:ap-1:cron:j1"), runOf("agent:ap-1:cron:j1"));
});
