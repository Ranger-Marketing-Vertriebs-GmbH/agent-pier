import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

const reminderBody = (name) => ({
  clientRequestId: `${name}-request`,
  name,
  message: `Remember ${name}`,
  schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
});

// A shared agent of Anna and Ben, with reminders on; both chats are open.
async function family(f, level = "personalize") {
  const anna = await signedInUser(f, "Anna");
  const ben = await signedInUser(f, "Ben");
  const agent = await userAgent(
    f,
    {
      mode: "shared",
      members: [
        { userId: anna.user.id, level },
        { userId: ben.user.id, level },
      ],
    },
    { capabilities: { memory: false, reminders: true } },
  );
  const open = async (cookie) =>
    (
      await (
        await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, { method: "POST" })
      ).json()
    ).id;
  return {
    anna,
    ben,
    agent,
    annaChat: await open(anna.cookie),
    benChat: await open(ben.cookie),
  };
}

const create = (f, cookie, agentId, name) =>
  as(f, cookie)(`/api/me/agents/${agentId}/reminders`, {
    method: "POST",
    body: reminderBody(name),
  });
const list = async (f, cookie, agentId) =>
  (await (await as(f, cookie)(`/api/me/agents/${agentId}/reminders`)).json()).reminders;

test("a user's reminder delivers into her chat only", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent, annaChat, benChat } = await family(f);
  const created = await create(f, anna.cookie, agent.id, "dentist");
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const reminders = f.application.assistants.reminders;
  const binding = reminders.bindings.get(id);
  assert.equal(binding.userId, anna.user.id);
  assert.equal(binding.target.conversationId, annaChat);
  await reminders.complete(id, {
    jobId: binding.nativeId,
    runAtMs: 1000,
    status: "ok",
    summary: "Dentist at three",
  });
  const results = f.application.assistants.reminders.results;
  assert.equal(results.forConversation(annaChat).length, 1);
  assert.equal(results.forConversation(benChat).length, 0);
});

test("user B cannot see or change A's reminder on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await family(f);
  const { id } = await (await create(f, anna.cookie, agent.id, "dentist")).json();
  assert.deepEqual(
    (await list(f, anna.cookie, agent.id)).map((r) => r.id),
    [id],
  );
  assert.deepEqual(await list(f, ben.cookie, agent.id), []);
  const patched = await as(f, ben.cookie)(`/api/me/agents/${agent.id}/reminders/${id}`, {
    method: "PATCH",
    body: { enabled: false, revision: 1 },
  });
  assert.equal(patched.status, 404);
  const removed = await as(f, ben.cookie)(`/api/me/agents/${agent.id}/reminders/${id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 404);
  // The owner's settings of a shared agent list only his own reminders.
  const owner = await (await f.request(`/api/assistants/${agent.id}/reminders`)).json();
  assert.deepEqual(owner.reminders, []);
  const ownerPatch = await f.request(`/api/assistants/${agent.id}/reminders/${id}`, {
    method: "PATCH",
    body: { enabled: false, revision: 1 },
  });
  assert.equal(ownerPatch.status, 404);
  // Anna changes her own.
  const own = await as(f, anna.cookie)(`/api/me/agents/${agent.id}/reminders/${id}`, {
    method: "DELETE",
  });
  assert.equal(own.status, 200, await own.clone().text());
});

test("the owner's reminder routes refuse a user's reminder on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await family(f);
  const created = await create(f, anna.cookie, agent.id, "dentist");
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const before = f.application.assistants.reminders.bindings.get(id);
  const base = `/api/assistants/${agent.id}/reminders/${id}`;
  for (const [method, endpoint, body] of [
    ["PATCH", base, { enabled: false, revision: 1 }],
    ["DELETE", base],
    ["POST", `${base}/review`, { outcome: "absent" }],
    ["GET", `${base}/runs`],
  ]) {
    const response = await f.request(endpoint, { method, body });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
  }
  assert.deepEqual(f.application.assistants.reminders.bindings.get(id), before);
});

test("a reminder created by the agent in A's turn belongs to A", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, annaChat, benChat } = await family(f);
  const send = async (cookie, chat) =>
    (
      await (
        await as(f, cookie)(`/api/me/conversations/${chat}/messages`, {
          method: "POST",
          body: { clientRequestId: `turn-${chat}`, text: "Remind me" },
        })
      ).json()
    ).attempt.id;
  const [a, b] = await Promise.all([
    send(anna.cookie, annaChat),
    send(ben.cookie, benChat),
  ]);
  const reminders = f.application.assistants.reminders;
  const invoke = (attemptId, name) =>
    reminders.invoke(
      { attemptId, toolCallId: `call-${name}`, assertCurrent: () => {} },
      {
        action: "create",
        name,
        message: name,
        schedule: reminderBody(name).schedule,
      },
    );
  const [forA, forB] = await Promise.all([invoke(a, "annas"), invoke(b, "bens")]);
  assert.equal(reminders.bindings.get(forA.id).userId, anna.user.id);
  assert.equal(reminders.bindings.get(forB.id).userId, ben.user.id);
  assert.equal(reminders.bindings.get(forA.id).target.conversationId, annaChat);
  assert.equal(reminders.bindings.get(forB.id).target.conversationId, benChat);
  // Each turn lists only its own person's reminders, and cannot remove another's.
  const listed = await reminders.invoke(
    { attemptId: a, toolCallId: "list", assertCurrent: () => {} },
    { action: "list" },
  );
  assert.deepEqual(
    listed.reminders.map((r) => r.id),
    [forA.id],
  );
  await assert.rejects(
    async () =>
      reminders.invoke(
        { attemptId: a, toolCallId: "remove", assertCurrent: () => {} },
        { action: "remove", id: forB.id },
      ),
    { status: 404 },
  );
});

test("check-ins are off on shared agents", async (t) => {
  const { f } = await chatFixture(t);
  const { agent } = await family(f);
  const heartbeats = f.application.assistants.reminders.heartbeats;
  const record = f.application.assistants.store.getAssistant(agent.id);
  assert.equal(
    heartbeats.eligible({
      ...record,
      capabilities: { ...record.capabilities, memory: true },
      heartbeat: { ...record.heartbeat, enabled: true },
    }),
    false,
  );
});

test("chat-only users cannot create reminders", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await family(f, "chat");
  const response = await create(f, anna.cookie, agent.id, "dentist");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "USER_LEVEL");
  assert.deepEqual(await list(f, anna.cookie, agent.id), []);
});

test("after a lowering to Chat only she can still pause and delete her own", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await family(f);
  const { id } = await (await create(f, anna.cookie, agent.id, "dentist")).json();
  const second = await (await create(f, anna.cookie, agent.id, "gym")).json();
  const store = f.application.assistants.store;
  const lowered = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: {
        mode: "shared",
        members: [
          { userId: anna.user.id, level: "chat" },
          { userId: ben.user.id, level: "personalize" },
        ],
      },
      revision: store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(lowered.status, 200, await lowered.clone().text());
  const path = `/api/me/agents/${agent.id}/reminders/${id}`;
  const [reminder] = (await list(f, anna.cookie, agent.id)).filter((r) => r.id === id);
  // Changing or resuming stays refused; pausing and deleting stop what she set up.
  for (const body of [
    { name: "x", revision: reminder.revision },
    { enabled: true, revision: reminder.revision },
    { enabled: false, name: "x", revision: reminder.revision },
  ]) {
    const refused = await as(f, anna.cookie)(path, { method: "PATCH", body });
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.equal((await refused.json()).code, "USER_LEVEL");
  }
  const paused = await as(f, anna.cookie)(path, {
    method: "PATCH",
    body: { enabled: false, revision: reminder.revision },
  });
  assert.equal(paused.status, 200, await paused.clone().text());
  assert.equal((await paused.json()).enabled, false);
  const removed = await as(f, anna.cookie)(
    `/api/me/agents/${agent.id}/reminders/${second.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, await removed.clone().text());
  // Ben's own at Personalize are not hers to stop.
  const his = await (await create(f, ben.cookie, agent.id, "ben")).json();
  const foreign = await as(f, anna.cookie)(
    `/api/me/agents/${agent.id}/reminders/${his.id}`,
    { method: "DELETE" },
  );
  assert.equal(foreign.status, 404);
});
