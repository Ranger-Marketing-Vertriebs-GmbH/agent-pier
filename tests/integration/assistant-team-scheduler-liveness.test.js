import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
const phases = (f, teamId) => f.service.store.members(teamId).map((m) => m.phase);
const count = (f, method) => f.calls.filter((c) => c.method === method).length;
async function ticks(service, n = 3) {
  for (let i = 0; i < n; i++) await service.reconcile();
}
function restart(t, f) {
  const service = new TeamService({
    assistants: f.assistants,
    config: f.assistants.config,
    autoStart: false,
    now: () => 0,
  });
  t.after(() => service.close());
  return service;
}
test("maintenance entered during a tick returns claimed members to the queue", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 2 });
  const tick = f.service.reconcile();
  f.assistants.maintenance = true;
  await tick;
  assert.deepEqual(phases(f, team.id), ["queued", "queued"]);
  f.assistants.maintenance = false;
  await ticks(f.service);
  for (const phase of phases(f, team.id))
    assert.ok(["admitting", "running"].includes(phase), phase);
  assert.equal(f.runs.size, 2);
});
test("closing admission during a tick leaves members queued across a restart", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 2 });
  const tick = f.service.reconcile();
  f.assistants.closed = true;
  await tick;
  f.assistants.closed = false;
  const next = restart(t, f);
  assert.deepEqual(phases(f, team.id), ["queued", "queued"]);
  assert.equal(f.profiles.size, 0);
  await ticks(next);
  assert.equal(f.runs.size, 2);
});
test("restart requeues a claim without step evidence and holds a claim with one", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 2 });
  const [claimed, applying] = f.service.store.members(team.id);
  f.service.store.write(claimed, { phase: "provisioning", claimedAt: 0 });
  f.service.store.write(applying, {
    phase: "provisioning",
    provisionStep: "session",
    claimedAt: 0,
  });
  restart(t, f);
  assert.deepEqual(phases(f, team.id), ["queued", "provisioning_uncertain"]);
});
test("uncertain profile application is re-applied when the gateway lacks the profile", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  f.loseProfile();
  await f.service.reconcile();
  const [member] = f.service.store.members(team.id);
  assert.equal(member.phase, "provisioning_uncertain");
  assert.equal(member.provisionStep, "profile");
  f.profiles.clear();
  await ticks(f.service);
  assert.equal(f.profiles.size, 1);
  assert.equal(f.service.store.member(member.id).phase, "running");
  assert.equal(count(f, "sessions.send"), 1);
});
test("uncertain session creation without a session or send creates the session again", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  f.loseSession();
  await f.service.reconcile();
  const [member] = f.service.store.members(team.id);
  assert.equal(member.phase, "provisioning_uncertain");
  assert.equal(member.provisionStep, "session");
  f.sessions.length = 0;
  await ticks(f.service);
  assert.equal(count(f, "sessions.create"), 2);
  assert.equal(f.service.store.member(member.id).phase, "running");
  assert.equal(count(f, "sessions.send"), 1);
});
test("uncertainty after a send is never replayed", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  f.loseSend();
  await ticks(f.service);
  assert.deepEqual(phases(f, team.id), ["uncertain"]);
  assert.equal(count(f, "sessions.send"), 1);
  assert.equal(count(f, "sessions.create"), 1);
});
test("stopping a provisioning member cancels it and frees its slot", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 4 }),
    { team: waiting } = await f.proposal({ count: 1 });
  f.service.store.saveSettings({ hostMaxConcurrent: 4 }, 1);
  const claimed = f.service.store.members(team.id);
  for (const m of claimed)
    f.service.store.write(m, { phase: "provisioning", claimedAt: 0 });
  await f.service.stop(team.id, claimed[0].id);
  assert.equal(f.service.store.member(claimed[0].id).phase, "cancelled");
  await ticks(f.service);
  assert.deepEqual(phases(f, waiting.id), ["running"]);
  assert.equal(f.runs.size, 1);
});
test("stopping a member while its profile is applied cancels before a session exists", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  let release;
  const apply = f.assistants.config.apply;
  f.assistants.config.apply = (id) => new Promise((r) => (release = () => r(apply(id))));
  const tick = f.service.reconcile();
  while (!release) await new Promise((r) => setImmediate(r));
  const [member] = f.service.store.members(team.id);
  await f.service.stop(team.id, member.id);
  assert.equal(f.service.store.member(member.id).phase, "cancelled");
  release();
  await tick;
  await ticks(f.service);
  assert.equal(f.service.store.member(member.id).phase, "cancelled");
  assert.equal(count(f, "sessions.create"), 0);
  assert.equal(f.runs.size, 0);
});
test("a concurrent team write does not abort the tick for other teams", async (t) => {
  const f = teamFixture(t);
  const teams = [];
  for (let i = 0; i < 3; i++) teams.push((await f.proposal({ count: 1 })).team);
  const [a, b, c] = teams.map((team) => team.id);
  const store = f.service.store,
    results = f.service.scheduler.results,
    collect = results.collect.bind(results);
  let concurrent = true,
    conflict = true,
    changed = 0;
  results.collect = async (id) => {
    if (id === a && concurrent) {
      concurrent = false;
      await new Promise((r) => setImmediate(r));
      store.write(store.get(b), {});
    }
    if (id === c && conflict) {
      conflict = false;
      store.write(store.get(c), {});
      throw Object.assign(Error("conflict"), { status: 409 });
    }
    return collect(id);
  };
  const notify = f.assistants.changed.bind(f.assistants);
  f.assistants.changed = () => {
    changed++;
    notify();
  };
  await f.service.reconcile();
  assert.ok(changed >= 1);
  assert.deepEqual(
    [a, b, c].map((id) => store.get(id).phase),
    ["running", "running", "running"],
  );
  await f.service.reconcile();
  assert.equal(f.runs.size, 3);
});
