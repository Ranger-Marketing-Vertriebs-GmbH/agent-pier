import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

test("sessions are a per-project switch inside the project grant", async (t) => {
  const f = await workflowFixture(t);
  const access = f.workflows.access;
  assert.deepEqual(access.get(f.id).sessionProjectIds, []);
  assert.equal(access.sessionsEnabled(f.id, f.project.id), false);
  const saved = access.save(f.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  assert.deepEqual(saved.sessionProjectIds, [f.project.id]);
  assert.equal(access.sessionsEnabled(f.id, f.project.id), true);
  // A save without the field keeps the stored switch.
  const kept = access.save(f.id, { ...f.policy }, saved.revision);
  assert.deepEqual(kept.sessionProjectIds, [f.project.id]);
  // Removing the project grant takes the switch along.
  const dropped = access.save(f.id, { ...f.policy, projectIds: [] }, kept.revision);
  assert.deepEqual(dropped.sessionProjectIds, []);
  assert.equal(access.sessionsEnabled(f.id, f.project.id), false);
});

test("a session project outside the project grant is refused", async (t) => {
  const f = await workflowFixture(t);
  const access = f.workflows.access;
  for (const sessionProjectIds of [["other"], "x", [f.project.id, f.project.id], [""]])
    assert.throws(() => access.save(f.id, { ...f.policy, sessionProjectIds }, 0), {
      status: 400,
    });
  assert.throws(
    () =>
      access.save(
        f.id,
        { ...f.policy, projectIds: [], sessionProjectIds: [f.project.id] },
        0,
      ),
    { status: 400 },
  );
});

test("a user agent can never hold session projects", async (t) => {
  const f = await workflowFixture(t);
  const body = { ...f.store.storedAssistant(f.id), userAccess };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  assert.throws(
    () =>
      f.workflows.access.save(
        f.id,
        { ...f.policy, projectIds: [], sessionProjectIds: [f.project.id] },
        0,
      ),
    { code: "USER_AGENT_LOCKED" },
  );
});

test("revokeProject removes the session switch too", async (t) => {
  const f = await workflowFixture(t);
  const access = f.workflows.access;
  access.save(f.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  f.workflows.revokeProject(f.project.id);
  const after = access.get(f.id);
  assert.deepEqual(after.projectIds, []);
  assert.deepEqual(after.sessionProjectIds, []);
});

test("an owner save audits sessionsAdded and sessionsRemoved", async (t) => {
  const f = await workflowFixture(t);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const access = f.workflows.access;
  const on = access.save(f.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  const added = audits.find((e) => e.details?.kind === "project-grants");
  assert.deepEqual(added.details.sessionsAdded, [f.project.id]);
  assert.deepEqual(added.details.sessionsRemoved, []);
  audits.length = 0;
  access.save(f.id, { ...f.policy, sessionProjectIds: [] }, on.revision);
  const removed = audits.find((e) => e.details?.kind === "project-grants");
  assert.deepEqual(removed.details.sessionsAdded, []);
  assert.deepEqual(removed.details.sessionsRemoved, [f.project.id]);
});
