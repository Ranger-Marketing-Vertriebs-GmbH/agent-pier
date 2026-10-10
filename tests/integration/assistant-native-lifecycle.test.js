import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
for (const scope of ["member", "team"]) {
  test(`archiving a ${scope} pauses permanent member reminders and restore keeps them paused`, async (t) => {
    const f = teamFixture(t),
      { team } = await f.proposal({ count: 1 });
    await f.service.reconcile();
    let member = f.service.store.members(team.id)[0];
    f.complete(member.attemptId);
    await f.service.reconcile();
    member = f.service.store.member(member.id);
    f.service.store.promote(member.id, member.revision);
    const profile = f.store.getAssistant(member.id);
    f.store.updateAssistant(
      member.id,
      { capabilities: { memory: true, reminders: true } },
      profile.revision,
    );
    const pauses = [],
      applied = [];
    f.assistants.reminders = {
      async disable(id) {
        pauses.push(id);
      },
      async close() {},
    };
    f.assistants.config.apply = async (id) => {
      applied.push(f.store.getAssistant(id).archivedAt);
    };
    const target = f.service.store.get(scope === "member" ? member.id : team.id);
    await assert.rejects(f.service.lifecycle("archive", target.id, target.revision - 1), {
      status: 409,
    });
    assert.equal(pauses.length, 0);
    const archived = await f.service.lifecycle("archive", target.id, target.revision);
    assert.deepEqual(pauses, [member.id]);
    assert.ok(f.store.getAssistant(member.id).archivedAt);
    assert.ok(applied[0]);
    await f.service.lifecycle("restore", target.id, archived.revision);
    assert.equal(pauses.length, 1);
    assert.equal(f.store.getAssistant(member.id).archivedAt, null);
  });
}
test("failed native pause prevents archival so recovery remains available", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  let member = f.service.store.members(team.id)[0];
  f.complete(member.attemptId);
  await f.service.reconcile();
  member = f.service.store.member(member.id);
  f.service.store.promote(member.id, member.revision);
  member = f.service.store.member(member.id);
  f.assistants.reminders = {
    async disable() {
      throw Error("Native pause unavailable");
    },
    async close() {},
  };
  await assert.rejects(
    f.service.lifecycle("archive", member.id, member.revision),
    /Native pause unavailable/,
  );
  assert.equal(f.store.getAssistant(member.id).archivedAt, null);
});
