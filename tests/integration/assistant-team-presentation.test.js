import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";

test("member provenance compares each field with its original snapshot, not today's parent", async (t) => {
  const f = teamFixture(t),
    { team, parent } = await f.proposal({ count: 1 });
  const m = f.service.store.members(team.id)[0];
  const original = f.store.getAssistant(m.assistantId);
  const current = () => f.service.list().members.find((x) => x.id === m.id);
  assert.deepEqual(current().overrides, { model: false, instructions: false });
  f.store.updateAssistant(
    parent.id,
    { instructions: "Changed parent", model: { connectionId: "new", modelId: "new" } },
    parent.revision,
  );
  assert.deepEqual(current().overrides, { model: false, instructions: false });
  let changed = f.store.updateAssistant(
    original.id,
    { model: { connectionId: "other", modelId: "m" } },
    original.revision,
  );
  assert.deepEqual(current().overrides, { model: true, instructions: false });
  changed = f.store.updateAssistant(
    original.id,
    { instructions: "Custom member instructions" },
    changed.revision,
  );
  assert.deepEqual(current().overrides, { model: true, instructions: true });
  f.store.updateAssistant(
    original.id,
    { model: original.model, instructions: original.instructions },
    changed.revision,
  );
  assert.deepEqual(current().overrides, { model: false, instructions: false });
  assert.equal(current().snapshot, undefined);
  assert.equal(current().instructions, undefined);
});

for (const [phases, expected] of [
  [["queued", "queued"], "queued"],
  [["running", "completed"], "running"],
  [["stopping", "running"], "stopping"],
  [["stopping", "uncertain"], "uncertain"],
  [["provisioning_uncertain", "running"], "uncertain"],
  [["completed", "failed"], "partial"],
  [["completed", "cancelled"], "partial"],
  [["failed", "cancelled"], "failed"],
  [["completed", "completed"], "completed"],
  [["cancelled", "cancelled"], "cancelled"],
])
  test(`team presentation retains ${expected} for ${phases.join(" + ")}`, async (t) => {
    const f = teamFixture(t),
      { team } = await f.proposal({ count: 2 });
    f.service.store
      .members(team.id)
      .forEach((m, n) => f.service.store.write(m, { phase: phases[n] }));
    const before = f.service.store.get(team.id);
    assert.equal(f.service.list().teams.find((x) => x.id === team.id).status, expected);
    assert.deepEqual(
      f.service.store.get(team.id),
      before,
      "projection must not mutate lifecycle or revisions",
    );
  });

test("mixed outcomes retain synthesis, archival and next-assignment admission", async (t) => {
  const f = teamFixture(t),
    { team, attempt, parent } = await f.proposal({ count: 2 });
  await f.service.reconcile();
  f.service.store
    .members(team.id)
    .forEach((m, n) => f.complete(m.attemptId, n ? "error" : "ok"));
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  const done = f.service.store.get(team.id);
  assert.equal(f.service.list().teams.find((x) => x.id === team.id).status, "partial");
  assert.ok(done.resultAttemptId);
  f.service.store.archive(team.id, done.revision);
  assert.ok((await f.proposal({ count: 1, parent })).team);
});
