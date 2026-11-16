import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { fixtureModel, ownUserAgent } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { compilerFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { desiredState } from "../../server/features/assistants/agent-desired-state.js";

// "Learns its own skills" through the routes (ADR 0007, step 6): the owner's switch,
// and the rule that an agent of restricted users never learns on the built-in
// runtime, on every path that could set it.
const json = (response) => response.json();
const tool = "skill_workshop";
const refused = async (response, label) => {
  assert.equal(response.status, 409, label);
  const body = await json(response);
  assert.equal(body.code, "USER_AGENT_SKILL_LEARNING", label);
  assert.equal(body.messageKey, "users.agentSkillLearning", label);
};
const listed = async (f, id) =>
  (await json(await f.request("/api/assistants"))).assistants.find((a) => a.id === id);
// What a Gateway start compiles from the stored agents.
function compiled(f) {
  const profiles = f.application.assistants.store.listAssistants();
  return compilerFor(null).compile({
    desired: desiredState({
      directory: "/plugin",
      connection: { url: "http://127.0.0.1:1", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles,
      sshAgents: new Set(),
    }),
    paths: { workspaces: path.join(f.dataDir, "w"), logs: path.join(f.dataDir, "l") },
    port: 1234,
    token: "t",
    existing: {
      agents: {
        entries: Object.fromEntries(profiles.map((p) => [p.runtimeAgentId, {}])),
      },
    },
  });
}
const create = (f, body) =>
  f.request("/api/assistants", {
    method: "POST",
    body: { name: "Mine", instructions: "", model: fixtureModel(f), ...body },
  });

test("the owner switches learning on and off for an own agent", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const agent = await json(await create(f));
  // Never chosen: the runtime's default, and nothing of it is compiled.
  assert.equal((await listed(f, agent.id)).skillLearning, false);
  assert.equal("skillLearningLocked" in (await listed(f, agent.id)), false);
  assert.equal(
    "skillLearning" in f.application.assistants.store.storedAssistant(agent.id),
    false,
  );
  assert.equal(compiled(f).skills.workshop.autonomous.mode, "off");
  assert.equal(JSON.stringify(compiled(f)).includes(tool), false);

  const invalid = await f.request(`/api/assistants/${agent.id}`, {
    method: "PATCH",
    body: { revision: agent.revision, skillLearning: "yes" },
  });
  assert.equal(invalid.status, 400);
  const on = await f.request(`/api/assistants/${agent.id}`, {
    method: "PATCH",
    body: { revision: agent.revision, skillLearning: true },
  });
  assert.equal(on.status, 200, await on.clone().text());
  const saved = await json(on);
  assert.equal(saved.skillLearning, true);
  const start = compiled(f);
  assert.equal(start.skills.workshop.autonomous.mode, "auto");
  assert.ok(start.agents.entries[saved.runtimeAgentId].tools.allow.includes(tool));
  assert.ok(start.tools.allow.includes(tool));

  const off = await f.request(`/api/assistants/${agent.id}`, {
    method: "PATCH",
    body: { revision: saved.revision, skillLearning: false },
  });
  assert.equal((await json(off)).skillLearning, false);
  assert.equal(JSON.stringify(compiled(f)).includes(tool), false);
  // A duplicate of an owner's agent carries the choice in its create body.
  const copy = await json(await create(f, { name: "Copy", skillLearning: true }));
  assert.equal((await listed(f, copy.id)).skillLearning, true);
});

test("a user agent cannot be created learning: new, as a duplicate, from a template", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { user } = await signedInUser(f, "Anna");
  const before = f.application.assistants.store.listAssistants().length;
  const post = (body) =>
    f.request("/api/user-agents", {
      method: "POST",
      body: {
        name: "Hers",
        instructions: "",
        model: fixtureModel(f),
        skillLearning: true,
        ...body,
      },
    });
  for (const mode of ["own", "shared"])
    await refused(
      await post({ userAccess: { mode, members: [{ userId: user.id, level: "chat" }] } }),
      mode,
    );
  // A duplicate sends its source's fields as a new agent's body: the same refusal.
  const source = await json(await create(f, { skillLearning: true }));
  await refused(
    await post({
      name: `${source.name} copy`,
      capabilities: source.capabilities,
      userAccess: { mode: "own", members: [{ userId: user.id, level: "chat" }] },
    }),
    "duplicate",
  );
  // From a template: the template names instructions, never this setting.
  f.application.assistants.templates = {
    template: async ({ id, revision }) => ({
      id,
      revision,
      name: "Template",
      source: "agency",
      scan: { verdict: "pass", rules: [], findings: [] },
    }),
  };
  await refused(
    await post({
      template: { id: "t1", revision: "r1" },
      userAccess: { mode: "own", members: [{ userId: user.id, level: "chat" }] },
    }),
    "template",
  );
  assert.equal(f.application.assistants.store.listAssistants().length, before + 1);
  // Without the field, and restating "off", a user agent is created as before.
  const { agent } = await ownUserAgent(f, { username: "Ben" });
  const view = await listed(f, agent.id);
  assert.equal(view.skillLearning, false);
  assert.equal(view.skillLearningLocked, true);
  const restated = await post({
    skillLearning: false,
    userAccess: { mode: "own", members: [{ userId: user.id, level: "chat" }] },
  });
  assert.equal(restated.status, 201);
});

test("a user agent cannot be switched to learning, by the owner or its user", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { agent, cookie } = await ownUserAgent(f, { level: "extended" });
  const patch = (body) =>
    f.request(`/api/assistants/${agent.id}`, {
      method: "PATCH",
      body: { revision: agent.revision, ...body },
    });
  await refused(await patch({ skillLearning: true }), "owner update");
  await refused(await patch({ name: "Renamed", skillLearning: true }), "with a name");
  assert.equal((await listed(f, agent.id)).name, agent.name);
  // Restating "off" is no change.
  assert.equal((await patch({ skillLearning: false })).status, 200);
  // Her own settings never take the field, at any level.
  const hers = await f.request(`/api/me/agents/${agent.id}/settings`, {
    method: "PATCH",
    headers: { cookie },
    body: { values: { skillLearning: true }, revision: agent.revision },
  });
  assert.equal(hers.status, 400);
  assert.equal(JSON.stringify(compiled(f)).includes(tool), false);
});

test("an agent that serves users stops learning, whatever its record says", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { user } = await signedInUser(f, "Anna");
  const { store } = f.application.assistants;
  const members = [{ userId: user.id, level: "chat" }];
  const created = await f.request("/api/user-agents", {
    method: "POST",
    body: {
      name: "Hers",
      instructions: "",
      model: fixtureModel(f),
      userAccess: { mode: "own", members },
    },
  });
  const agent = await json(created);
  // A stored "on" from elsewhere (a restored backup, an edited database): written
  // past every route, as nothing else can set it for a user agent.
  store.changeUserAgent(agent.id, { skillLearning: true });
  const stored = store.storedAssistant(agent.id);
  assert.equal(stored.skillLearning, true);
  const view = await listed(f, agent.id);
  assert.equal(view.skillLearning, false);
  assert.equal(view.skillLearningLocked, true);
  const start = compiled(f);
  assert.equal(start.skills.workshop.autonomous.mode, "off");
  assert.equal(
    start.agents.entries[agent.runtimeAgentId].tools.allow.includes(tool),
    false,
  );
  assert.equal(start.tools.allow.includes(tool), false);
  // The next assignment removes the stored value for good.
  const assigned = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ userId: user.id, level: "extended" }] },
      revision: stored.revision,
    },
  });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  assert.equal("skillLearning" in store.storedAssistant(agent.id), false);
});
