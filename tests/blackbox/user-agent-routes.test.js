import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { fixtureModel, ownUserAgent } from "../helpers/user-agents.js";
import { notFoundBody } from "../../server/http/responses.js";

const json = (response) => response.json();

test("owner creates an own agent for a user", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { user, agent } = await ownUserAgent(f, {
    level: "personalize",
    body: { shell: "full", confirmShell: true, confirmFull: true, browserVisible: true },
  });
  assert.deepEqual(agent.userAccess, {
    mode: "own",
    members: [{ userId: user.id, level: "personalize" }],
    released: [],
  });
  assert.equal(agent.shell, "off");
  assert.equal(agent.browserVisible, false);
  const listed = (await json(await f.request("/api/assistants"))).assistants;
  assert.deepEqual(listed.find((a) => a.id === agent.id).userAccess, agent.userAccess);
  assert.deepEqual(
    f.application.userScope.agentsFor(user.id).map((a) => a.id),
    [agent.id],
  );
  assert.equal(f.application.userScope.level(agent.id, user.id), "personalize");
  assert.equal(f.application.userScope.level(agent.id, "someone-else"), null);
});

test("own agents take exactly one member", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const anna = (await signedInUser(f, "Anna")).user;
  const ben = (await signedInUser(f, "Ben")).user;
  const members = [
    { userId: anna.id, level: "chat" },
    { userId: ben.id, level: "chat" },
  ];
  const response = await f.request("/api/user-agents", {
    method: "POST",
    body: {
      name: "Two",
      instructions: "",
      model: fixtureModel(f),
      userAccess: { mode: "own", members },
    },
  });
  assert.equal(response.status, 400);
  assert.equal((await json(response)).code, "USER_AGENT_ACCESS_INVALID");
  const shared = await f.request("/api/user-agents", {
    method: "POST",
    body: {
      name: "Family",
      instructions: "",
      model: fixtureModel(f),
      userAccess: { mode: "shared", members },
    },
  });
  assert.equal(shared.status, 201);
  const agent = await json(shared);
  // The owner moves it to Anna alone; a stale revision is a conflict.
  const own = { mode: "own", members: [members[0]], released: ["webSearch"] };
  const stale = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: { userAccess: own, revision: 0 },
  });
  assert.equal(stale.status, 409);
  const moved = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: { userAccess: own, revision: agent.revision },
  });
  assert.equal(moved.status, 200);
  assert.deepEqual((await json(moved)).userAccess, own);
  assert.deepEqual(f.application.userScope.agentsFor(ben.id), []);
});

test("existing owner agents cannot become user agents", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { user } = await signedInUser(f);
  const created = await f.request("/api/assistants", {
    method: "POST",
    body: { name: "Mine", instructions: "", model: fixtureModel(f) },
  });
  const owner = await json(created);
  const response = await f.request(`/api/user-agents/${owner.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ userId: user.id, level: "chat" }] },
      revision: owner.revision,
    },
  });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).code, "USER_AGENT_REQUIRED");
});

test("levels and released capabilities are validated", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { user } = await signedInUser(f);
  for (const userAccess of [
    { mode: "own", members: [{ userId: user.id, level: "admin" }] },
    { mode: "own", members: [{ userId: user.id, level: "chat" }], released: ["shell"] },
    { mode: "own", members: [{ userId: "unknown", level: "chat" }] },
  ]) {
    const response = await f.request("/api/user-agents", {
      method: "POST",
      body: { name: "Bad", instructions: "", model: fixtureModel(f), userAccess },
    });
    assert.equal(response.status, 400, JSON.stringify(userAccess));
    assert.equal((await json(response)).code, "USER_AGENT_ACCESS_INVALID");
  }
});

test("a user is denied the assignment routes", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { cookie, agent } = await ownUserAgent(f);
  for (const [endpoint, method] of [
    ["/api/user-agents", "POST"],
    [`/api/user-agents/${agent.id}/access`, "PUT"],
  ]) {
    const response = await f.request(endpoint, {
      method,
      headers: { cookie },
      body: {},
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await json(response), notFoundBody());
  }
});

test("assignment routes answer ASSISTANTS_DISABLED while agents are off", async (t) => {
  const f = await applicationFixture(t);
  const response = await f.request("/api/user-agents", { method: "POST", body: {} });
  assert.equal(response.status, 404);
  assert.equal((await json(response)).code, "ASSISTANTS_DISABLED");
});
