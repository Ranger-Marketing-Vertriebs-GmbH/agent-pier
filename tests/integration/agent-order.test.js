import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { as, userAgent } from "../helpers/user-chats.js";
import { followAgentList } from "../../server/features/assistants/live-topics.js";
import { followAgentEvents } from "../../server/features/users/live-me-topics.js";
import {
  mergeOrder,
  OWNER_ORDER,
  sortByOrder,
} from "../../server/features/assistants/agent-order.js";
import { lifecycleFixture } from "../helpers/agent-lifecycle-fixture.js";

async function ownerAgent(f, name, body = {}) {
  const response = await f.request("/api/assistants", {
    method: "POST",
    body: { name, model: fixtureModel(f), ...body },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
const ownerOrder = async (f) =>
  (await (await f.request("/api/assistants")).json()).agentOrder;
const saveOwner = (f, ids) =>
  f.request("/api/assistant-order", { method: "PUT", body: { ids } });

test("merging keeps unnamed (archived) agents in their slots", () => {
  assert.deepEqual(mergeOrder(["a", "x", "b", "c"], ["c", "b", "a"]), [
    "c",
    "x",
    "b",
    "a",
  ]);
  assert.deepEqual(mergeOrder([], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(mergeOrder(["a", "b"], ["b", "a", "n"]), ["b", "a", "n"]);
  assert.deepEqual(
    sortByOrder([{ id: "n" }, { id: "a" }, { id: "b" }], ["b", "a"]).map((a) => a.id),
    ["b", "a", "n"],
  );
});

test("the owner's order is stored, pushed on agent.list, survives a restart and puts new agents last", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  const a = await ownerAgent(f, "Alpha");
  const b = await ownerAgent(f, "Beta");
  const c = await ownerAgent(f, "Gamma");
  assert.deepEqual(await ownerOrder(f), []);
  let changes = 0;
  const stop = followAgentList({ assistants: service }, () => changes++);
  t.after(stop);
  const response = await saveOwner(f, [c.id, a.id, b.id]);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).ids, [c.id, a.id, b.id]);
  assert.ok(changes > 0, "a saved order signals agent.list");
  assert.deepEqual(await ownerOrder(f), [c.id, a.id, b.id]);
  // A new agent has no position: the list shows it after the positioned ones.
  const d = await ownerAgent(f, "Delta");
  const listed = await (await f.request("/api/assistants")).json();
  assert.deepEqual(
    sortByOrder(listed.assistants, listed.agentOrder).map((agent) => agent.id),
    [c.id, a.id, b.id, d.id],
  );
  stop();
  await f.restart();
  assert.deepEqual(await ownerOrder(f), [c.id, a.id, b.id]);
});

test("archived agents keep their place for a restore", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  const a = await ownerAgent(f, "Alpha");
  const b = await ownerAgent(f, "Beta");
  const c = await ownerAgent(f, "Gamma");
  assert.equal((await saveOwner(f, [a.id, b.id, c.id])).status, 200);
  service.store.changeUserAgent(b.id, { archivedAt: new Date().toISOString() });
  // The browser no longer shows Beta and sends the others only.
  assert.equal((await saveOwner(f, [c.id, a.id])).status, 200);
  assert.deepEqual(await ownerOrder(f), [c.id, b.id, a.id]);
});

test("a permanent delete through the agent lifecycle drops the agent's place", async (t) => {
  const f = lifecycleFixture(t);
  const other = f.populated("Other");
  const { agent } = f.populated();
  const order = f.assistants.agentOrder;
  order.save(OWNER_ORDER, [agent.id, other.agent.id], () => true);
  await f.lifecycle.archive(agent.id, { revision: agent.revision });
  assert.deepEqual(order.of(OWNER_ORDER), [agent.id, other.agent.id]);
  await f.lifecycle.delete(agent.id, { name: "Helper" });
  assert.deepEqual(order.of(OWNER_ORDER), [other.agent.id]);
});

test("malformed bodies are refused; ids gone since the list was read are left out", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const a = await ownerAgent(f, "Alpha");
  const b = await ownerAgent(f, "Beta");
  assert.equal((await saveOwner(f, [b.id, a.id])).status, 200);
  for (const ids of [undefined, "x", [a.id, a.id], [a.id, 3], [""]])
    assert.equal((await saveOwner(f, ids)).status, 400, JSON.stringify(ids));
  assert.deepEqual(await ownerOrder(f), [b.id, a.id]);
  // Another tab deleted an agent this one still shows: the rest is saved.
  const response = await saveOwner(f, [a.id, "deleted-elsewhere", b.id]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).ids, [a.id, b.id]);
  assert.deepEqual(await ownerOrder(f), [a.id, b.id]);
});

test("each person orders her own list: users never touch the owner's or each other's order", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  const anna = await signedInUser(f, "Anna");
  const ben = await signedInUser(f, "Ben");
  const member = (user) => ({ userId: user.user.id, level: "chat" });
  const first = await userAgent(
    f,
    { mode: "shared", members: [member(anna), member(ben)] },
    {
      name: "Family",
    },
  );
  const second = await userAgent(
    f,
    { mode: "own", members: [member(anna)] },
    {
      name: "Anna's helper",
    },
  );
  const third = await userAgent(
    f,
    { mode: "own", members: [member(ben)] },
    {
      name: "Ben's helper",
    },
  );
  const owner = await ownerAgent(f, "Owner's own");
  const annaRequest = as(f, anna.cookie);
  const benRequest = as(f, ben.cookie);
  const names = async (request) =>
    (await (await request("/api/me/agents")).json()).map((agent) => agent.name);
  assert.deepEqual(await names(annaRequest), ["Family", "Anna's helper"]);

  let events = 0;
  const stop = followAgentEvents(
    { assistants: service },
    () => events++,
    () => () => {},
  );
  t.after(stop);
  let response = await annaRequest("/api/me/agents/order", {
    method: "PUT",
    body: { ids: [second.id, first.id] },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(events > 0, "her write signals her me.agents topic");
  assert.deepEqual(await names(annaRequest), ["Anna's helper", "Family"]);
  // Ben's order and the owner's stay as they were.
  assert.deepEqual(await names(benRequest), ["Family", "Ben's helper"]);
  assert.deepEqual(await ownerOrder(f), []);

  // Agents she does not see (Ben's, the owner's) are left out and never stored or
  // answered for her; a stale list still saves the agents she sees.
  const saveAnna = async (ids) => {
    const answer = await annaRequest("/api/me/agents/order", {
      method: "PUT",
      body: { ids },
    });
    assert.equal(answer.status, 200, JSON.stringify(ids));
    return (await answer.json()).ids;
  };
  assert.deepEqual(await saveAnna([third.id, owner.id]), [second.id, first.id]);
  assert.deepEqual(await saveAnna([first.id, third.id, second.id]), [
    first.id,
    second.id,
  ]);
  assert.deepEqual(service.agentOrder.of(`user:${anna.user.id}`), [first.id, second.id]);
  assert.deepEqual(await names(annaRequest), ["Family", "Anna's helper"]);
  // An agent taken from her keeps its stored slot, but her answer never names it.
  service.store.changeUserAgent(second.id, { archivedAt: new Date().toISOString() });
  assert.deepEqual(await saveAnna([first.id]), [first.id]);
  service.store.changeUserAgent(second.id, { archivedAt: null });
  // The owner's route is not hers.
  response = await annaRequest("/api/assistant-order", {
    method: "PUT",
    body: { ids: [first.id] },
  });
  assert.equal(response.status, 404);

  // The owner sorts users' agents in his own view only.
  assert.equal(
    (await saveOwner(f, [first.id, second.id, third.id, owner.id])).status,
    200,
  );
  assert.deepEqual(await names(annaRequest), ["Family", "Anna's helper"]);
  assert.deepEqual(await ownerOrder(f), [first.id, second.id, third.id, owner.id]);

  // Her order goes with her.
  response = await f.request(`/api/users/${anna.user.id}`, {
    method: "DELETE",
    body: { agents: "archive" },
  });
  assert.equal(response.status, 204, await response.clone().text());
  assert.deepEqual(service.agentOrder.of(`user:${anna.user.id}`), []);
  // The secrets pass that agent change started finishes before the store closes.
  await f.application.assistantAgentSecrets?.refresh();
});

test("dropping into another group moves the agent and orders it there", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const group = f.application.assistants.agentGroups.create("Work");
  const a = await ownerAgent(f, "Alpha");
  const b = await ownerAgent(f, "Beta", { areaGroupId: group.id });
  // What the sidebar sends for a drop of Alpha above Beta in Work.
  let response = await f.request(`/api/assistants/${a.id}/group`, {
    method: "PUT",
    body: { groupId: group.id, previousGroupId: null },
  });
  assert.equal(response.status, 200);
  response = await saveOwner(f, [a.id, b.id]);
  assert.equal(response.status, 200);
  const listed = await (await f.request("/api/assistants")).json();
  assert.deepEqual(listed.agentGroups[0].assistantIds.sort(), [a.id, b.id].sort());
  assert.deepEqual(listed.agentOrder, [a.id, b.id]);
});
