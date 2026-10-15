import test from "node:test";
import assert from "node:assert/strict";
import { WriteGuardReapply } from "../../server/features/assistants/write-guard-reapply.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

const memory = { memory: true };
function fixture({ profiles, fail = new Set(), blocked = new Set() } = {}) {
  const applied = [],
    warnings = [],
    infos = [],
    admissions = [];
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
    // Called before each apply's own effect; tests change the world from here.
    beforeApply: () => {},
    config: {
      apply: async (id) => {
        applied.push(id);
        assistants.beforeApply(id);
        if (fail.has(id)) throw Object.assign(Error("lost"), { code: "LOST" });
      },
    },
    admit: (fn) => {
      admissions.push("admit");
      return Promise.resolve().then(fn);
    },
  };
  const reapply = new WriteGuardReapply({
    assistants,
    live: () => state.live,
    generation: () => state.generation,
    blocked: (id) => blocked.has(id),
    warn: (...args) => warnings.push(args.join(" ")),
    info: (...args) => infos.push(args.join(" ")),
  });
  return { reapply, assistants, applied, warnings, infos, admissions, state, fail };
}
const three = ["a", "b", "c"].map((id) => ({ id, capabilities: memory }));

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

test("agents whose model connection is blocked are skipped", async () => {
  const f = fixture({ profiles: three, blocked: new Set(["b"]) });
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "c"]);
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "c"], "a blocked agent keeps no pass open");
});

test("concurrent reports of one generation share a single pass", async () => {
  const f = fixture();
  await Promise.all([f.reapply.request(), f.reapply.request(), f.reapply.request()]);
  assert.deepEqual(f.applied, ["a", "b"]);
});

test("each apply is admitted on its own so chat turns interleave", async () => {
  const f = fixture({ profiles: three });
  const order = [];
  // A chat turn asks for admission while the first agent is being applied.
  f.assistants.beforeApply = (id) => {
    order.push(id);
    if (id === "a")
      f.assistants.admit(async () => {
        order.push("chat");
      });
  };
  await f.reapply.request();
  // Let the queued chat admission settle.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.admissions.length, 4, "three applies and one chat admission");
  assert.ok(order.indexOf("chat") < order.indexOf("c"), JSON.stringify(order));
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

test("a guard lost mid-pass resumes with the remaining agents on the next report", async () => {
  const f = fixture({ profiles: three });
  // A reconnect drops the guard right after the first agent was applied.
  f.assistants.beforeApply = (id) => {
    if (id === "a") f.state.live = false;
  };
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a"]);
  f.state.live = true;
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "c"], "only the remaining agents");
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "c"]);
});

test("an agent skipped while waiting for admission is not counted as applied", async () => {
  const f = fixture({ profiles: three });
  const admit = f.assistants.admit;
  let n = 0;
  // The guard drops while the second agent waits for its admission.
  f.assistants.admit = (fn) => {
    if (++n === 2) f.state.live = false;
    return admit(fn);
  };
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a"]);
  f.state.live = true;
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "c"]);
});

test("a failed apply is retried on the next report and logged once", async () => {
  const f = fixture();
  f.fail.add("a");
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b"]);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /write guard/i);
  assert.match(f.warnings[0], /LOST/);
  // One retry per report, never a loop within one.
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "a"]);
  assert.equal(f.warnings.length, 1, "a repeated failure is not warned again");
  f.fail.delete("a");
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "a", "a"]);
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "b", "a", "a"], "done once every agent applied");
});

test("a new generation mid-pass stops the old pass and runs the new one once", async () => {
  const f = fixture({ profiles: three });
  let second;
  f.assistants.beforeApply = (id) => {
    if (id !== "a" || f.state.generation !== 1) return;
    // A restart happens and its guard reports while generation 1 is applying.
    f.state.generation = 2;
    second = f.reapply.request();
  };
  await f.reapply.request();
  await second;
  await f.reapply.request();
  assert.deepEqual(f.applied, ["a", "a", "b", "c"]);
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
  assert.deepEqual(f.warnings, [], "a recovering service is expected, not a warning");
  assert.equal(f.infos.length, 1);
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
