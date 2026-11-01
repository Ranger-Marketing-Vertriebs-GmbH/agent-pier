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
  const job = { name: "Inbox", agentId: "ap-1", enabled: true, wakeMode: "now" };
  await routines.list({ agentId: "ap-1" });
  await routines.list();
  await routines.add({ job });
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
  assert.deepEqual(await routines.add({ job: {} }), { id: "j1" });
  assert.deepEqual(await routines.add({ job: {} }), { id: "j2" });
  assert.equal(await routines.add({ job: {} }), null);
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
    bound.add({ job: {} }),
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
