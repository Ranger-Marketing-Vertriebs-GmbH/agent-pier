import test from "node:test";
import assert from "node:assert/strict";
import { signedInUser } from "../helpers/users.js";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import {
  followAgentList,
  agentListOf,
} from "../../server/features/assistants/live-topics.js";

test("owner group writes publish the agent list, persist, and do not restart agents", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  let changes = 0;
  const stop = followAgentList({ assistants: service }, () => changes++);
  t.after(stop);
  const request = (url, method, body) => f.request(`/api${url}`, { method, body });
  let response = await request("/assistant-groups", "POST", { name: "Development" });
  assert.equal(response.status, 201, await response.clone().text());
  const group = await response.json();
  const connection = f.application.providerConnections.create({
    name: "Test",
    providerId: "openrouter",
    apiKey: "test-only",
  });
  response = await request("/assistants", "POST", {
    name: "Developer",
    model: { connectionId: connection.id, modelId: "test" },
    areaGroupId: group.id,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const agent = await response.json();
  assert.ok(agentListOf(service).agentGroups[0].assistantIds.includes(agent.id));
  const before = service.store.getAssistant(agent.id);
  const previousChanges = changes;
  response = await request(`/assistants/${agent.id}/group`, "PUT", {
    groupId: null,
    previousGroupId: group.id,
  });
  assert.equal(response.status, 200);
  assert.ok(changes > previousChanges, "assignment invalidates agent.list");
  assert.deepEqual(service.store.getAssistant(agent.id), before);
  const listed = await (await f.request("/api/assistants")).json();
  assert.deepEqual(listed.agentGroups[0].assistantIds, []);
  response = await request("/assistants", "POST", {
    name: "Invalid",
    model: agent.model,
    areaGroupId: "missing",
  });
  assert.equal(response.status, 404);
  assert.equal(service.store.listAssistants().length, 1);
  response = await f.request("/api/assistant-groups", {
    method: "POST",
    body: { name: "Foreign" },
    origin: "https://foreign.invalid",
  });
  assert.equal(response.status, 403);
  assert.equal(
    (
      await fetch(f.url + "/api/assistant-groups", {
        method: "POST",
        headers: { "content-type": "application/json", origin: f.url },
        body: '{"name":"Unauthorized"}',
      })
    ).status,
    401,
  );
  stop();
  await f.restart();
  assert.equal(
    (await (await f.request("/api/assistants")).json()).agentGroups[0].id,
    group.id,
  );
});

test("restricted users cannot manage or discover owner group metadata", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { cookie } = await signedInUser(f);
  const group = f.application.assistants.agentGroups.create("Private area");
  for (const [method, endpoint, body] of [
    ["GET", "/assistants"],
    ["POST", "/assistant-groups", { name: "New" }],
    ["PATCH", `/assistant-groups/${group.id}`, { name: "Changed", revision: 1 }],
    ["POST", `/assistant-groups/${group.id}/order`, { direction: "up", revision: 1 }],
    ["DELETE", `/assistant-groups/${group.id}`, { revision: 1 }],
    ["PUT", "/assistants/unknown/group", { groupId: group.id, previousGroupId: null }],
  ]) {
    const response = await f.request(`/api${endpoint}`, {
      method,
      body,
      headers: { cookie },
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
  }
  assert.equal(f.application.assistants.agentGroups.get(group.id).name, "Private area");
});
