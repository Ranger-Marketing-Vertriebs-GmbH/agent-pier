import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

const access = (revision, changes = {}) => ({
  revision,
  projectIds: [],
  pipelineIds: [],
  memoryWrite: true,
  autonomous: false,
  publish: false,
  ...changes,
});
const team = (revision, changes = {}) => ({
  revision,
  autonomous: true,
  maxMembers: 3,
  runTimeoutMinutes: 15,
  ...changes,
});

test("an agent's work settings save together or not at all", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application.assistants;
  const agent = a.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const put = (body) =>
    f.request(`/api/assistants/${agent.id}/work`, { method: "PUT", body });
  const stored = async () => ({
    access: await (await f.request(`/api/assistants/${agent.id}/access`)).json(),
    team: a.teams.store.policy(agent.id),
  });

  const saved = await put({ access: access(0), team: team(1) });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.access.revision, 1);
  assert.equal(body.access.memoryWrite, true);
  assert.deepEqual(body.team, {
    revision: 2,
    autonomous: true,
    // Saved without a level: the default for new and existing agents.
    usage: "suggest",
    maxMembers: 3,
    runTimeoutMinutes: 15,
    memberShellSsh: false,
  });

  // A stale revision on either part leaves both rows as they are.
  assert.equal(
    (await put({ access: access(0), team: team(2, { maxMembers: 5 }) })).status,
    409,
  );
  assert.equal(
    (await put({ access: access(1, { memoryWrite: false }), team: team(1) })).status,
    409,
  );
  let now = await stored();
  assert.equal(now.access.revision, 1);
  assert.equal(now.access.memoryWrite, true);
  assert.equal(now.team.revision, 2);
  assert.equal(now.team.maxMembers, 3);

  // A valid access part is not written when the team part is invalid.
  assert.equal(
    (
      await put({
        access: access(1, { memoryWrite: false }),
        team: team(2, { maxMembers: 99 }),
      })
    ).status,
    400,
  );
  now = await stored();
  assert.equal(now.access.memoryWrite, true);
  assert.equal(now.access.revision, 1);

  // The host capacity still bounds the team size.
  a.teams.store.saveSettings({ hostMaxConcurrent: 4 }, 1);
  const over = await put({ team: team(2, { maxMembers: 5 }) });
  assert.equal(over.status, 409);
  // Capacity has its own message key, so it is not mistaken for a stale revision.
  assert.equal((await over.json()).messageKey, "assistants.capacity");

  // One part alone is fine; the other is returned as stored.
  const teamOnly = await put({ team: team(2, { maxMembers: 4 }) });
  assert.equal(teamOnly.status, 200);
  const teamBody = await teamOnly.json();
  assert.equal(teamBody.team.revision, 3);
  assert.equal(teamBody.access.revision, 1);

  assert.equal((await put({})).status, 400);
  assert.equal((await put({ access: access(1), extra: true })).status, 400);
  assert.equal((await put({ access: { ...access(1), revision: "1" } })).status, 400);
  assert.equal(
    (
      await f.request(`/api/assistants/${agent.id}/work`, {
        method: "PUT",
        body: { team: team(3) },
        origin: "https://foreign.invalid",
      })
    ).status,
    403,
  );
});

test("work and team-policy routes answer with agent message keys", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application.assistants;
  const agent = a.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const put = (body) =>
    f.request(`/api/assistants/${agent.id}/work`, { method: "PUT", body });

  // A pipeline the workflow service does not know is the agent route's 404.
  const unknown = await put({ access: access(0, { pipelineIds: ["missing-pipeline"] }) });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).messageKey, "assistants.notFound");

  // Maintenance refuses the save with the agent's own key.
  a.maintenance = true;
  try {
    const busy = await put({ team: team(1) });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).messageKey, "assistants.active");
  } finally {
    a.maintenance = false;
  }

  // The legacy team-policy route reports capacity with its own key as well.
  a.teams.store.saveSettings({ hostMaxConcurrent: 4 }, 1);
  const over = await f.request(`/api/assistants/${agent.id}/team-policy`, {
    method: "PUT",
    body: team(1, { maxMembers: 5 }),
  });
  assert.equal(over.status, 409);
  assert.equal((await over.json()).messageKey, "assistants.capacity");
});
