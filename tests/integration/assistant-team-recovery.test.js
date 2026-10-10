import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
for (const mode of ["loseProfile", "loseSession", "loseSend"])
  test(`${mode} adopts durable identities without replaying creation or execution`, async (t) => {
    const f = teamFixture(t),
      { team } = await f.proposal({ count: 1 });
    f[mode]();
    await f.service.reconcile();
    const first = f.service.store.members(team.id)[0];
    assert.ok(["uncertain", "provisioning_uncertain"].includes(first.phase));
    await f.service.reconcile();
    await f.service.reconcile();
    assert.equal(f.sessions.length, 1);
    assert.equal(f.runs.size, 1);
    assert.equal(f.calls.filter((c) => c.method === "sessions.send").length, 1);
  });
test("ambiguous session after uncertain creation stays blocked", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  f.loseSession();
  await f.service.reconcile();
  f.sessions.push({ ...f.sessions[0], key: "duplicate" });
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(f.calls.filter((c) => c.method === "sessions.create").length, 1);
  assert.equal(f.runs.size, 0);
  assert.equal(f.service.store.members(team.id)[0].phase, "provisioning_uncertain");
});
test("parent cancellation does not stop members; stop member and team stay distinct", async (t) => {
  const f = teamFixture(t),
    { team, attempt } = await f.proposal();
  await f.service.reconcile();
  f.assistants.ledger.transition(attempt.id, "cancelled");
  const [member] = f.service.store.members(team.id);
  await f.service.stop(team.id, member.id);
  assert.equal(
    f.service.store.members(team.id).filter((m) => m.phase === "stopping").length,
    1,
  );
  await f.service.stop(team.id);
  assert.ok(f.service.store.members(team.id).every((m) => m.phase === "stopping"));
});
test("policy revocation during model validation is observed before admission", async (t) => {
  const f = teamFixture(t),
    { team, parent, attempt } = await f.proposal({ allowed: false });
  await f.service.decide(
    team.id,
    { revision: team.revision, decision: "decline" },
    { kind: "owner" },
  );
  f.service.store.savePolicy(parent.id, { autonomous: true }, 1);
  let release;
  f.assistants.models.resolve = () =>
    new Promise((r) => (release = () => r({ release() {} })));
  const pending = f.service.propose(
    { attemptId: attempt.id, toolCallId: "delayed", assertCurrent() {} },
    { objective: "Delayed", members: [{ name: "A", role: "R", assignment: "Task" }] },
  );
  f.service.store.savePolicy(parent.id, { autonomous: false }, 2);
  release();
  assert.equal((await pending).phase, "awaiting_approval");
});
test("member settings cannot change while reserved even before a run exists", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  await assert.rejects(
    f.assistants.update(team.memberIds[0], { instructions: "Override" }, 1),
    { status: 409 },
  );
});
test("restart recovers an admitted run by its persisted request identity without execution replay", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const m = f.service.store.members(team.id)[0];
  f.service.store.write(m, { phase: "admitting", attemptId: null });
  f.assistants.markOutstandingUnknown();
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(f.service.store.member(m.id).attemptId, m.attemptId);
  assert.equal(f.service.store.member(m.id).phase, "uncertain");
  assert.equal(f.calls.filter((c) => c.method === "sessions.send").length, 1);
});
test("owner can retire unknown provisioning without allocating a replacement", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  f.loseSession();
  await f.service.reconcile();
  f.sessions.length = 0;
  const m = f.service.store.members(team.id)[0];
  let stopped = 0;
  f.assistants.runtime.stop = async () => {
    stopped++;
  };
  f.assistants.ledger.transition(team.parentAttemptId, "completed");
  await f.service.recoverMember(m.id, {
    acknowledgeUnknownOutcome: true,
    revision: m.revision,
  });
  assert.equal(stopped, 1);
  assert.equal(f.service.store.member(m.id).phase, "failed");
  await f.service.reconcile();
  assert.equal(f.calls.filter((c) => c.method === "sessions.create").length, 1);
});
test("an owner stop ends members as cancelled, a deadline stop as failed", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 2 });
  await f.service.reconcile();
  await f.service.stop(team.id);
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId, "error");
  await f.service.reconcile();
  assert.ok(f.service.store.members(team.id).every((m) => m.phase === "cancelled"));
  assert.equal(f.service.store.get(team.id).phase, "cancelled");
  const g = teamFixture(t),
    late = await g.proposal({ count: 1 });
  await g.service.reconcile();
  g.clock(600001);
  await g.service.reconcile();
  for (const m of g.service.store.members(late.team.id)) g.complete(m.attemptId, "error");
  await g.service.reconcile();
  assert.equal(g.service.store.members(late.team.id)[0].phase, "failed");
});
test("a stopped member persisted before stop reasons existed keeps its failure", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const [m] = f.service.store.members(team.id);
  f.service.store.write(m, { phase: "stopping", stopRequested: true });
  f.complete(m.attemptId, "error");
  await f.service.reconcile();
  assert.equal(f.service.store.member(m.id).phase, "failed");
});
