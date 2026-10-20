import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

const routineBody = (name) => ({
  clientRequestId: `${name}-request`,
  name,
  prompt: `Check ${name}`,
  trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
});

// A shared agent of Anna and Ben with routines on; both chats are open.
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

const routes = (f, cookie, agentId) => {
  const request = as(f, cookie);
  const base = `/api/me/agents/${agentId}/routines`;
  return {
    create: (name, extra = {}) =>
      request(base, { method: "POST", body: { ...routineBody(name), ...extra } }),
    list: async () => (await (await request(base)).json()).routines,
    patch: (id, body) => request(`${base}/${id}`, { method: "PATCH", body }),
    remove: (id) => request(`${base}/${id}`, { method: "DELETE" }),
  };
};

test("a user's routine runs in her own chat and only she sees it", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, ben, agent, annaChat } = await family(f);
  const annas = routes(f, anna.cookie, agent.id);
  const created = await annas.create("bank");
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const binding = f.application.assistants.reminders.bindings.get(id);
  assert.equal(binding.userId, anna.user.id);
  assert.equal(binding.target.conversationId, annaChat);
  const job = gateway.jobs.get(binding.nativeId);
  const store = f.application.assistants.store;
  assert.equal(job.sessionKey, store.getConversation(annaChat).runtimeSessionKey);
  assert.deepEqual(
    (await annas.list()).map((r) => r.id),
    [id],
  );
  const bens = routes(f, ben.cookie, agent.id);
  assert.deepEqual(await bens.list(), []);
  assert.equal((await bens.patch(id, { enabled: false, revision: 1 })).status, 404);
  assert.equal((await bens.remove(id)).status, 404);
  // The owner's settings of the shared agent leave her routine out.
  const owner = await (await f.request(`/api/assistants/${agent.id}/routines`)).json();
  assert.deepEqual(owner.routines, []);
  const removed = await annas.remove(id);
  assert.equal(removed.status, 200, await removed.clone().text());
});

test("users never switch on 'May write' for their routines", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await family(f);
  const annas = routes(f, anna.cookie, agent.id);
  const created = await annas.create("files", { writes: true });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const bindings = f.application.assistants.reminders.bindings;
  assert.notEqual(bindings.get(id).routineWrites, true);
  const patched = await annas.patch(id, { writes: true, enabled: false, revision: 1 });
  assert.equal(patched.status, 200, await patched.clone().text());
  assert.notEqual(bindings.get(id).routineWrites, true);
  assert.equal((await annas.list())[0].writes, false);
  assert.ok(
    !f.application.audit
      .list({})
      .events.some((event) => event.details?.kind === "routine-writes"),
  );
});

test("the owner's routine routes refuse a user's routine on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await family(f);
  const created = await routes(f, anna.cookie, agent.id).create("bank");
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const before = f.application.assistants.reminders.bindings.get(id);
  const base = `/api/assistants/${agent.id}/routines/${id}`;
  for (const [method, endpoint, body] of [
    ["PATCH", base, { enabled: false, revision: 1 }],
    ["DELETE", base],
    ["POST", `${base}/events`, { clientRequestId: "owner-event" }],
    ["POST", `${base}/review`, { outcome: "absent" }],
    ["GET", `${base}/runs`],
  ]) {
    const response = await f.request(endpoint, { method, body });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
  }
  assert.deepEqual(f.application.assistants.reminders.bindings.get(id), before);
});
