import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import {
  projectAgents,
  setProjectAgent,
} from "../../server/features/assistants/project-agent-access.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};
const none = { coding: false, folder: "none" };

async function setup(t) {
  const f = await workflowFixture(t);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  f.assistants.teams = {
    ...f.assistants.teams,
    store: new TeamStore({ store: f.store }),
  };
  const services = {
    assistants: f.assistants,
    access: f.workflows.access,
    teams: f.assistants.teams.store,
  };
  return { ...f, audits, accessApi: f.workflows.access, projectServices: services };
}

test("an old row without the field reads talkProjectIds []", async (t) => {
  const f = await setup(t);
  f.store.db
    .prepare("INSERT INTO assistant_access VALUES(?,?)")
    .run(f.id, JSON.stringify({ ...f.policy, revision: 1 }));
  assert.deepEqual(f.accessApi.get(f.id).talkProjectIds, []);
});

test("existing coding and session grants never imply the talk grant", async (t) => {
  const f = await setup(t);
  const saved = f.accessApi.save(
    f.id,
    { ...f.policy, projectIds: [f.project.id], sessionProjectIds: [f.project.id] },
    0,
  );
  assert.deepEqual(saved.talkProjectIds, []);
  assert.deepEqual(f.accessApi.get(f.id).talkProjectIds, []);
});

test("talk projects must be granted projects", async (t) => {
  const f = await setup(t);
  for (const talkProjectIds of [["other"], "x", [f.project.id, f.project.id]])
    assert.throws(
      () => f.accessApi.save(f.id, { ...f.policy, talkProjectIds }, 0),
      (error) => error.key === "invalid",
    );
  const saved = f.accessApi.save(
    f.id,
    { ...f.policy, talkProjectIds: [f.project.id] },
    0,
  );
  assert.deepEqual(saved.talkProjectIds, [f.project.id]);
});

test("removing the project removes its talk grant", async (t) => {
  const f = await setup(t);
  const saved = f.accessApi.save(
    f.id,
    { ...f.policy, talkProjectIds: [f.project.id] },
    0,
  );
  // A save without the field keeps the grant while the project stays.
  const kept = f.accessApi.save(f.id, { ...f.policy }, saved.revision);
  assert.deepEqual(kept.talkProjectIds, [f.project.id]);
  const dropped = f.accessApi.save(f.id, { ...f.policy, projectIds: [] }, kept.revision);
  assert.deepEqual(dropped.talkProjectIds, []);
  const again = f.accessApi.save(
    f.id,
    { ...f.policy, talkProjectIds: [f.project.id] },
    dropped.revision,
  );
  const before = f.accessApi.get(f.id).revision;
  assert.deepEqual(again.talkProjectIds, [f.project.id]);
  f.workflows.revokeProject(f.project.id);
  const after = f.accessApi.get(f.id);
  assert.deepEqual(after.talkProjectIds, []);
  assert.ok(after.revision > before);
});

test("a user agent cannot hold a talk grant", async (t) => {
  const f = await setup(t);
  const body = { ...f.store.storedAssistant(f.id), userAccess };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  assert.throws(
    () =>
      f.accessApi.save(
        f.id,
        { ...f.policy, projectIds: [], talkProjectIds: [f.project.id] },
        0,
      ),
    { code: "USER_AGENT_LOCKED" },
  );
});

test("the project view reads and writes talk", async (t) => {
  const f = await setup(t);
  const set = (input) => setProjectAgent(f.projectServices, f.project.id, f.id, input);
  const view = () => projectAgents(f.projectServices, f.project.id).agents[0];
  f.accessApi.save(f.id, { ...f.policy, projectIds: [] }, 0);
  assert.equal(view().talk, false);
  const saved = set({
    expected: none,
    coding: true,
    folder: "none",
    talk: true,
  });
  assert.equal(saved.talk, true);
  assert.deepEqual(f.accessApi.get(f.id).talkProjectIds, [f.project.id]);
  assert.equal(view().talk, true);
  assert.throws(
    () =>
      set({
        expected: { coding: true, folder: "none", talk: true },
        coding: false,
        folder: "none",
        talk: true,
      }),
    (error) => error.key === "invalid",
  );
  // Removing the coding grant takes the talk grant with it.
  const off = set({
    expected: { coding: true, folder: "none", talk: true },
    coding: false,
    folder: "none",
  });
  assert.equal(off.talk, false);
});

test("the audit names talk grants", async (t) => {
  const f = await setup(t);
  f.accessApi.save(f.id, { ...f.policy, talkProjectIds: [f.project.id] }, 0);
  const updated = f.audits.find((e) => e.details?.kind === "project-grants");
  assert.deepEqual(updated.details.talkAdded, [f.project.id]);
  assert.deepEqual(updated.details.talkRemoved, []);
});
