import test from "node:test";
import assert from "node:assert/strict";

const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
// A routine as AgentPier submits it (server/features/assistants/routine-definition.js).
const routine = (agentId, name, extra = {}) => ({
  name,
  marker: `agentpier-reminder:${name}`,
  agentId,
  enabled: true,
  keepAfterRun: true,
  schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  wakeNow: true,
  alertOnFailure: false,
  target: { kind: "chat", sessionKey: `agent:${agentId}:main` },
  prompt: { text: name, timeoutSeconds: 300, fullContext: true, tools: ["read"] },
  delivery: { kind: "chat", url: `http://127.0.0.1:1/complete/${name}` },
  ...extra,
});
// The fields a runtime answers as AgentPier submitted them.
const definitionOf = ({ name, marker, agentId, schedule, target, prompt, delivery }) => ({
  name,
  marker,
  agentId,
  schedule,
  target,
  prompt,
  delivery,
});

/**
 * The routines sub-port of the runtime port contract (runtime-port-contract.js):
 * routines in AgentPier's model added, listed per agent, changed, run and removed, the
 * scheduler's status, run sessions told apart, a view bound to a replaced connection,
 * and all of it while the runtime is unreachable. `singleAgent`: the runtime serves
 * the agent "ap-1" alone (Hermes: one process set per agent) and refuses a routine
 * of any other.
 */
export function routinesContract(name, make, { singleAgent = false } = {}) {
  const other = singleAgent ? "ap-1" : "ap-2";
  test(`${name}: routines are added, listed per agent, changed and removed`, async () => {
    const { routines } = await make({});
    const first = await routines.add({ routine: routine("ap-1", "Inbox") });
    assert.equal(typeof first.id, "string");
    assert.deepEqual(definitionOf(first), definitionOf(routine("ap-1", "Inbox")));
    assert.equal(first.enabled, true);
    assert.equal(typeof first.revision, "number");
    const second = await routines.add({
      routine: routine(other, "Report", {
        target: { kind: "own" },
        delivery: { kind: "webhook", url: "http://127.0.0.1:1/complete/r" },
        schedule: { kind: "at", at: "2026-11-02T09:00:00Z" },
      }),
    });
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.target, { kind: "own" });
    assert.deepEqual(second.schedule, { kind: "at", at: "2026-11-02T09:00:00Z" });
    assert.deepEqual(
      (await routines.list({ agentId: "ap-1" })).map((r) => r.id).sort(),
      (singleAgent ? [first.id, second.id] : [first.id]).sort(),
    );
    if (singleAgent) {
      assert.deepEqual(await routines.list({ agentId: "ap-2" }), []);
      await assert.rejects(
        routines.add({ routine: routine("ap-2", "Foreign") }),
        (e) => e.code === "INVALID_REQUEST",
      );
    }
    assert.deepEqual(
      (await routines.list()).map((r) => r.id).sort(),
      [first.id, second.id].sort(),
    );
    const paused = await routines.update({ id: first.id, patch: { enabled: false } });
    assert.equal(paused.id, first.id);
    assert.equal(paused.enabled, false);
    assert.notEqual(paused.revision, first.revision);
    // Disabled routines are listed too, with what they run.
    const listed = (await routines.list({ agentId: "ap-1" })).find(
      (r) => r.id === first.id,
    );
    assert.equal(listed.enabled, false);
    assert.deepEqual(definitionOf(listed), definitionOf(first));
    // A patch changes only the fields it names.
    const prompt = { text: "Changed", timeoutSeconds: 300, fullContext: true, tools: [] };
    const changed = await routines.update({
      id: first.id,
      patch: { name: "New", prompt },
    });
    assert.deepEqual(
      [changed.name, changed.prompt, changed.target, changed.enabled],
      ["New", prompt, first.target, false],
    );
    await routines.remove({ id: first.id });
    assert.deepEqual(
      (await routines.list({ agentId: "ap-1" })).map((r) => r.id),
      singleAgent ? [second.id] : [],
    );
  });

  test(`${name}: a forced run is queued and the runs are listed`, async () => {
    const { routines } = await make({});
    const added = await routines.add({
      routine: routine("ap-1", "Hook", { enabled: false }),
    });
    // A disabled routine runs only when forced.
    assert.deepEqual(await routines.run({ id: added.id }), {
      queued: false,
      refused: true,
    });
    assert.deepEqual(await routines.run({ id: added.id, force: true }), {
      queued: true,
      refused: false,
    });
    const { entries } = await routines.runs({ id: added.id, limit: 20 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "ok");
    assert.equal(typeof (await routines.status()).enabled, "boolean");
    // The run's session names the routine and the run.
    const run = routines.runOf(entries[0].sessionKey);
    assert.equal(run.agentId, "ap-1");
    assert.equal(run.routineId, added.id);
    assert.equal(typeof run.runId, "string");
    assert.equal(typeof run.routineSession, "string");
    assert.deepEqual(routines.runOf(run.routineSession), {
      ...run,
      runId: null,
    });
  });

  test(`${name}: runOf answers null for a session of no routine`, async () => {
    const { routines } = await make({ unreachable: true });
    for (const key of [undefined, null, 1, "", "agent:ap-1:main", "x"])
      assert.equal(routines.runOf(key), null, String(key));
  });

  test(`${name}: a routines view bound to a replaced connection reaches nothing`, async () => {
    const runtime = await make({});
    const bound = runtime.routines.on(runtime.host.connection());
    const kept = await bound.add({ routine: routine("ap-1", "Kept") });
    await runtime.host.restart();
    for (const pending of [
      bound.list({ agentId: "ap-1" }),
      bound.add({ routine: routine("ap-1", "Lost") }),
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
      listed.map((r) => [r.id, r.enabled]),
      [[kept.id, true]],
    );
  });

  test(`${name}: routines reject while unreachable`, async () => {
    const { routines } = await make({ unreachable: true });
    const calls = {
      list: () => routines.list({ agentId: "ap-1" }),
      add: () => routines.add({ routine: routine("ap-1", "x") }),
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
 * Routines held in memory for the fake runtime, kept across restarts, in AgentPier's
 * model as given. Every call goes through `reach`, which rejects while the runtime is
 * unreachable; a view bound to a replaced connection rejects as closed. A disabled
 * routine runs only when forced. Run sessions are `fake:<agent>:routine:<id>`, per
 * run `…:run:<n>`.
 */
export function fakeRoutinePorts({ reach, connection }) {
  const routines = new Map();
  const runs = new Map();
  let created = 0;
  const copy = (value) => structuredClone(value);
  const session = (r) => `fake:${r.agentId}:routine:${r.id}`;
  const runSession = /^(fake:([^:]+):routine:([^:]+))(?::run:([^:]+))?$/;
  const methods = {
    list: ({ agentId } = {}) =>
      reach(() =>
        [...routines.values()].filter((r) => !agentId || r.agentId === agentId).map(copy),
      ),
    add: ({ routine: definition }) =>
      reach(() => {
        const id = `fake-routine-${++created}`;
        routines.set(id, { ...copy(definition), id, revision: 1, runState: {} });
        return copy(routines.get(id));
      }),
    update: ({ id, patch }) =>
      reach(() => {
        const old = routines.get(id);
        if (!old) throw Object.assign(new Error("unknown routine"), { answered: true });
        routines.set(id, { ...old, ...copy(patch), revision: old.revision + 1 });
        return copy(routines.get(id));
      }),
    remove: ({ id }) => reach(() => ({ removed: routines.delete(id) })),
    run: ({ id, force = false }) =>
      reach(() => {
        const found = routines.get(id);
        const runnable = !!found && (force || found.enabled);
        if (runnable) {
          const list = runs.get(id) || [];
          const sessionKey = `${session(found)}:run:${list.length + 1}`;
          runs.set(id, [...list, { runAtMs: Date.now(), status: "ok", sessionKey }]);
        }
        return { queued: runnable, refused: !runnable };
      }),
    runs: ({ id, limit }) =>
      reach(() => ({ entries: (runs.get(id) || []).slice(-limit).reverse() })),
    status: () => reach(() => ({ enabled: true })),
    runOf(sessionKey) {
      const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
      return match
        ? {
            agentId: match[2],
            routineId: match[3],
            runId: match[4] ?? null,
            routineSession: match[1],
          }
        : null;
    },
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
          name === "runOf"
            ? method
            : (...args) => (bound && bound === connection() ? method(...args) : closed()),
        ]),
      ),
    );
  return { routines: { ...methods, on } };
}
