import test from "node:test";
import assert from "node:assert/strict";
import { WriteGuardReapply } from "../../server/features/assistants/write-guard-reapply.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

const memory = { memory: true };
function fixture({ profiles, fail = new Set(), admit } = {}) {
  const applied = [],
    warnings = [];
  const state = { live: true, generation: 1 };
  const assistants = {
    maintenance: false,
    runtime: {
      availability: "ready",
      status: () => ({ availability: assistants.runtime.availability }),
    },
    store: {
      listAssistants: () =>
        profiles || [
          { id: "a", capabilities: memory },
          { id: "b", capabilities: memory },
          { id: "c", capabilities: { memory: false } },
          { id: "d", capabilities: memory, archivedAt: "2026-10-01T00:00:00Z" },
        ],
    },
    config: {
      apply: async (id) => {
        applied.push(id);
        if (fail.has(id)) throw Object.assign(Error("lost"), { code: "LOST" });
      },
    },
    admit: admit || ((fn) => Promise.resolve().then(fn)),
  };
  const reapply = new WriteGuardReapply({
    assistants,
    live: () => state.live,
    generation: () => state.generation,
    warn: (...args) => warnings.push(args.join(" ")),
  });
  return { reapply, assistants, applied, warnings, state };
}

test("a live guard re-applies every active memory agent once per generation", async () => {
  const f = fixture();
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"], "archived and memoryless agents are skipped");
  // The plugin repeats its report periodically; the same generation applies nothing.
  await f.reapply.request();
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
  // A fresh Gateway start compiles without writes again.
  f.state.generation = 2;
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "a", "b"]);
});

test("concurrent reports of one generation share a single pass", async () => {
  const f = fixture();
  await Promise.all([f.reapply.request(), f.reapply.request(), f.reapply.request()]);
  assert.deepEqual(f.applied, ["a", "b"]);
});

test("nothing is applied while the guard is not live for this generation", async () => {
  const f = fixture();
  f.state.live = false;
  await f.reapply.request();
  assert.deepEqual(f.applied, []);
  f.state.live = true;
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
});

test("a guard reported while the Gateway is still starting waits for its readiness", async () => {
  const f = fixture();
  // The plugin registers its guard during the Gateway's own start, before the
  // client is ready; an apply then fails and the pass would be lost.
  f.assistants.runtime.availability = "starting";
  await f.reapply.request();
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.warnings, []);
  // Readiness (gatewayEvents.ready) asks again.
  f.assistants.runtime.availability = "ready";
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
});

test("a failing agent is logged and the others are still applied", async () => {
  const f = fixture({ fail: new Set(["a"]) });
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /write guard/i);
  assert.match(f.warnings[0], /LOST/);
  // A failed agent is not retried in a loop by the periodic report.
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
});

test("maintenance defers the pass and a refused admission retries on the next report", async () => {
  const f = fixture();
  f.assistants.maintenance = true;
  await f.reapply.request();
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.warnings, [], "maintenance is expected, not a warning");
  f.assistants.maintenance = false;
  let refuse = true;
  f.assistants.admit = (fn) =>
    refuse
      ? Promise.reject(Object.assign(Error("unavailable"), { status: 503 }))
      : Promise.resolve().then(fn);
  await f.reapply.request();
  assert.deepEqual(f.applied, []);
  assert.equal(f.warnings.length, 1);
  refuse = false;
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
});

test("every accepted guard report notifies the bridge's hook", () => {
  const assistants = {
    changed() {},
    runtime: { child: { pid: 42 }, status: () => ({ version: "2026.10.3" }) },
  };
  const bridge = new TeamBridge({ assistants, teams: {}, generation: () => 7 });
  bridge.closed = false;
  let reports = 0;
  bridge.onGuard = () => reports++;
  bridge.registerGuard({ pid: 42, ppid: 1 });
  bridge.registerGuard({ pid: 42, ppid: 1 });
  assert.equal(reports, 2);
  assert.equal(bridge.guardLive(), true);
  assert.throws(() => bridge.registerGuard({ pid: 9, ppid: 1 }));
  assert.equal(reports, 2, "a refused report notifies nothing");
});
