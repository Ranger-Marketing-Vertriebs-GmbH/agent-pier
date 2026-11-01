import test from "node:test";
import assert from "node:assert/strict";

const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
// A job as AgentPier submits it: the runtime's own fields, kept as given.
const job = (agentId, name, extra = {}) => ({
  name,
  declarationKey: `agentpier-reminder:${name}`,
  agentId,
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  payload: { kind: "agentTurn", message: name },
  ...extra,
});

/**
 * The routines sub-port of the runtime port contract (runtime-port-contract.js): jobs
 * added, listed per agent, changed, run and removed, the scheduler's status, a view
 * bound to a replaced connection, and all of it while the runtime is unreachable.
 */
export function routinesContract(name, make) {
  test(`${name}: routines are added, listed per agent, changed and removed`, async () => {
    const { routines } = await make({});
    const first = await routines.add({ job: job("ap-1", "Inbox") });
    assert.equal(typeof first.id, "string");
    assert.equal(first.declarationKey, "agentpier-reminder:Inbox");
    const second = await routines.add({ job: job("ap-2", "Report") });
    assert.notEqual(second.id, first.id);
    assert.deepEqual(
      (await routines.list({ agentId: "ap-1" })).map((j) => j.id),
      [first.id],
    );
    assert.deepEqual(
      (await routines.list()).map((j) => j.id).sort(),
      [first.id, second.id].sort(),
    );
    const paused = await routines.update({ id: first.id, patch: { enabled: false } });
    assert.equal(paused.id, first.id);
    assert.equal(paused.enabled, false);
    // Disabled jobs are listed too.
    const [listed] = await routines.list({ agentId: "ap-1" });
    assert.equal(listed.enabled, false);
    assert.deepEqual(listed.payload, first.payload);
    await routines.remove({ id: first.id });
    assert.deepEqual(await routines.list({ agentId: "ap-1" }), []);
  });

  test(`${name}: a forced run is queued and the runs are listed`, async () => {
    const { routines } = await make({});
    const added = await routines.add({ job: job("ap-1", "Hook", { enabled: false }) });
    // A disabled job runs only when forced.
    assert.deepEqual(await routines.run({ id: added.id }), {
      queued: false,
      refused: true,
    });
    assert.deepEqual(await routines.run({ id: added.id, force: true }), {
      queued: true,
      refused: false,
    });
    const { entries } = await routines.runs({ id: added.id, limit: 20 });
    assert.ok(Array.isArray(entries));
    assert.equal(typeof (await routines.status()).enabled, "boolean");
  });

  test(`${name}: a routines view bound to a replaced connection reaches nothing`, async () => {
    const runtime = await make({});
    const bound = runtime.routines.on(runtime.host.connection());
    const kept = await bound.add({ job: job("ap-1", "Kept") });
    await runtime.host.restart();
    for (const pending of [
      bound.list({ agentId: "ap-1" }),
      bound.add({ job: job("ap-1", "Lost") }),
      bound.update({ id: kept.id, patch: { enabled: false } }),
      bound.remove({ id: kept.id }),
      bound.run({ id: kept.id, force: true }),
      bound.runs({ id: kept.id, limit: 20 }),
      bound.status(),
    ])
      await assert.rejects(pending, unavailable);
    // The new connection received none of it.
    const listed = await runtime.routines.list({ agentId: "ap-1" });
    assert.deepEqual(
      listed.map((j) => [j.id, j.enabled]),
      [[kept.id, true]],
    );
  });

  test(`${name}: routines reject while unreachable`, async () => {
    const { routines } = await make({ unreachable: true });
    const calls = {
      list: () => routines.list({ agentId: "ap-1" }),
      add: () => routines.add({ job: job("ap-1", "x") }),
      update: () => routines.update({ id: "j", patch: { enabled: false } }),
      remove: () => routines.remove({ id: "j" }),
      run: () => routines.run({ id: "j", force: true }),
      runs: () => routines.runs({ id: "j", limit: 20 }),
      status: () => routines.status(),
    };
    for (const [method, call] of Object.entries(calls)) {
      // A rejection, never a synchronous throw: callers await it inside try/catch.
      const pending = call();
      assert.ok(pending instanceof Promise, method);
      await assert.rejects(pending, method);
    }
  });
}

/**
 * Routines held in memory for the fake runtime, kept across restarts. Every call goes
 * through `reach`, which rejects while the runtime is unreachable; a view bound to a
 * replaced connection rejects as closed. A disabled job runs only when forced.
 */
export function fakeRoutinePorts({ reach, connection }) {
  const jobs = new Map();
  const runs = new Map();
  let created = 0;
  const copy = (value) => structuredClone(value);
  const methods = {
    list: ({ agentId } = {}) =>
      reach(() =>
        [...jobs.values()].filter((j) => !agentId || j.agentId === agentId).map(copy),
      ),
    add: ({ job: definition }) =>
      reach(() => {
        const added = { ...copy(definition), id: `fake-job-${++created}` };
        jobs.set(added.id, { ...added, updatedAtMs: 1, state: {} });
        return copy(jobs.get(added.id));
      }),
    update: ({ id, patch }) =>
      reach(() => {
        const old = jobs.get(id);
        if (!old) throw Object.assign(new Error("unknown job"), { answered: true });
        jobs.set(id, { ...old, ...copy(patch), updatedAtMs: old.updatedAtMs + 1 });
        return copy(jobs.get(id));
      }),
    remove: ({ id }) => reach(() => ({ removed: jobs.delete(id) })),
    run: ({ id, force = false }) =>
      reach(() => {
        const runnable = jobs.has(id) && (force || jobs.get(id).enabled);
        if (runnable) runs.set(id, [...(runs.get(id) || []), { status: "ok" }]);
        return { queued: runnable, refused: !runnable };
      }),
    runs: ({ id, limit }) =>
      reach(() => ({ entries: (runs.get(id) || []).slice(-limit).reverse() })),
    status: () => reach(() => ({ enabled: true })),
  };
  const closed = () =>
    Promise.reject(
      Object.assign(new Error("closed"), { code: "UNAVAILABLE", status: 503 }),
    );
  const on = (bound) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(methods).map(([name, method]) => [
          name,
          (...args) => (bound && bound === connection() ? method(...args) : closed()),
        ]),
      ),
    );
  return { routines: { ...methods, on } };
}
