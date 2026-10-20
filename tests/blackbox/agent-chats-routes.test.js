import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";

// The owner's agent, created through his API.
async function ownerAgent(f, body = {}) {
  const response = await f.request("/api/assistants", {
    method: "POST",
    body: { name: "Helper", instructions: "", model: fixtureModel(f), ...body },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

// The person's main chat (the owner's without `cookie`) and a new chat.
const openMain = async (request, agentId, user) =>
  (
    await json(
      await request(
        user
          ? `/api/me/agents/${agentId}/conversation`
          : `/api/assistants/${agentId}/conversations`,
        { method: "POST" },
      ),
      200,
    )
  ).id;
const newChat = async (request, agentId, user) =>
  json(
    await request(
      user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`,
      {
        method: "POST",
      },
    ),
    201,
  );
const chats = async (request, agentId, user, query = "") =>
  json(
    await request(
      `${user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`}${query}`,
    ),
    200,
  );

test("New chat starts a separate session and the main chat stays the delivery target", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "personalize" }] },
    { capabilities: { memory: false, reminders: true } },
  );
  const request = as(f, anna.cookie);
  const main = await openMain(request, agent.id, true);
  const second = await newChat(request, agent.id, true);
  const store = f.application.assistants.store;
  assert.notEqual(second.id, main);
  assert.notEqual(
    store.getConversation(second.id).runtimeSessionKey,
    store.getConversation(main).runtimeSessionKey,
  );
  assert.equal(store.getConversation(main).main, true);
  assert.equal(store.getConversation(second.id).main, undefined);
  // The new chat is its own native session, labelled with its conversation id.
  assert.equal(gateway.created.at(-1).label, `AgentPier ${agent.id} chat ${second.id}`);
  assert.ok(!gateway.calls.some((c) => c.method === "sessions.reset"));
  const listed = await chats(request, agent.id, true);
  assert.deepEqual(
    listed.map((c) => [c.id, c.main]),
    [
      [main, true],
      [second.id, false],
    ],
  );
  // A reminder created now still delivers into the main chat.
  const created = await json(
    await request(`/api/me/agents/${agent.id}/reminders`, {
      method: "POST",
      body: {
        clientRequestId: "dentist-request",
        name: "dentist",
        message: "Remember the dentist",
        schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
      },
    }),
    201,
  );
  const reminders = f.application.assistants.reminders;
  const binding = reminders.bindings.get(created.id);
  assert.equal(binding.target.conversationId, main);
  await reminders.complete(created.id, {
    jobId: binding.nativeId,
    runAtMs: 1000,
    status: "ok",
    summary: "Dentist at three",
  });
  assert.equal(reminders.results.forConversation(main).length, 1);
  assert.equal(reminders.results.forConversation(second.id).length, 0);
});

test("an earlier chat can be reopened and continued", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const main = await openMain(f.request, agent.id);
  const sent = await f.request(`/api/assistant-conversations/${main}/messages`, {
    method: "POST",
    body: { clientRequestId: "one", text: "First" },
  });
  assert.equal(sent.status, 202);
  const assistants = f.application.assistants;
  // The first turn ends before the second chat starts.
  gateway.runs[gateway.sent[0].idempotencyKey] = { status: "ok" };
  await assistants.reconcile();
  await newChat(f.request, agent.id);
  const again = await f.request(`/api/assistant-conversations/${main}/messages`, {
    method: "POST",
    body: { clientRequestId: "two", text: "Second" },
  });
  assert.equal(again.status, 202, await again.clone().text());
  const history = await json(
    await f.request(`/api/assistant-conversations/${main}/messages`),
    200,
  );
  assert.deepEqual(
    history.requests.map((r) => r.text),
    ["First", "Second"],
  );
  const key = assistants.store.getConversation(main).runtimeSessionKey;
  assert.deepEqual(
    gateway.sent.map((s) => s.key),
    [key, key],
  );
});

test("each user has her own chat list on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const annaRequest = as(f, anna.cookie);
  const benRequest = as(f, ben.cookie);
  const annaMain = await openMain(annaRequest, agent.id, true);
  const annaSecond = await newChat(annaRequest, agent.id, true);
  const benMain = await openMain(benRequest, agent.id, true);
  const ownerMain = await openMain(f.request, agent.id);
  const ownerSecond = await newChat(f.request, agent.id);
  assert.deepEqual(
    (await chats(annaRequest, agent.id, true)).map((c) => c.id).sort(),
    [annaMain, annaSecond.id].sort(),
  );
  assert.deepEqual(
    (await chats(benRequest, agent.id, true)).map((c) => c.id),
    [benMain],
  );
  // Without the users' opt-in the owner lists his own chats only.
  assert.deepEqual(
    (await chats(f.request, agent.id)).map((c) => c.id).sort(),
    [ownerMain, ownerSecond.id].sort(),
  );
});

test("user A cannot open, list or post to B's chats", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const benRequest = as(f, ben.cookie);
  await openMain(benRequest, agent.id, true);
  const benSecond = await newChat(benRequest, agent.id, true);
  const annaRequest = as(f, anna.cookie);
  for (const [method, endpoint, body] of [
    ["GET", `/api/me/conversations/${benSecond.id}/messages`],
    [
      "POST",
      `/api/me/conversations/${benSecond.id}/messages`,
      { clientRequestId: "x", text: "hi" },
    ],
    ["POST", `/api/me/conversations/${benSecond.id}/queued`, { text: "later" }],
  ]) {
    const response = await annaRequest(endpoint, { method, ...(body ? { body } : {}) });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await response.json(), notFoundBody());
  }
  assert.deepEqual(await chats(annaRequest, agent.id, true), []);
  // Another user's agent is unknown too.
  const carla = await signedInUser(f, "Carla");
  const carlaRequest = as(f, carla.cookie);
  for (const [method, endpoint] of [
    ["GET", `/api/me/agents/${agent.id}/chats`],
    ["POST", `/api/me/agents/${agent.id}/chats`],
  ]) {
    const response = await carlaRequest(endpoint, { method });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await response.json(), notFoundBody());
  }
});

test("owner agents get several chats too", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  // A new chat on an agent without chats opens its main chat first.
  const first = await newChat(f.request, agent.id);
  assert.equal(first.main, true);
  const second = await newChat(f.request, agent.id);
  const third = await newChat(f.request, agent.id);
  assert.equal(second.main, false);
  const listed = await chats(f.request, agent.id);
  assert.equal(listed[0].id, first.id);
  assert.deepEqual(
    listed.map((c) => c.id).sort(),
    [first.id, second.id, third.id].sort(),
  );
  for (const chat of listed)
    assert.deepEqual(Object.keys(chat).sort(), [
      "archivedAt",
      "busy",
      "id",
      "lastActivityAt",
      "main",
      "title",
      "userId",
    ]);
  // The owner never starts a chat with a user's own agent.
  const anna = await signedInUser(f, "Anna");
  const own = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const refused = await f.request(`/api/assistants/${own.id}/chats`, { method: "POST" });
  assert.equal(refused.status, 404);
});

test("legacy agents keep their existing chat as main", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const store = f.application.assistants.store;
  // A conversation stored before chats had a main flag.
  const legacy = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "agent:legacy:1",
  });
  assert.equal(legacy.main, undefined);
  assert.equal(await openMain(f.request, agent.id), legacy.id);
  assert.equal(gateway.created.length, 0);
  assert.equal(store.getConversation(legacy.id).main, true);
  const listed = await chats(f.request, agent.id);
  assert.deepEqual(
    listed.map((c) => [c.id, c.main]),
    [[legacy.id, true]],
  );
});

const post = (request, endpoint, body) => request(endpoint, { method: "POST", body });
const title = async (request, agentId, id, user) =>
  (await chats(request, agentId, user)).find((c) => c.id === id)?.title;

test("a set title survives later turns", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const chat = await newChat(f.request, agent.id);
  const assistants = f.application.assistants;
  // The first turn names the chat.
  const sent = await post(f.request, `/api/assistant-conversations/${chat.id}/messages`, {
    clientRequestId: "one",
    text: "Plan the   trip to Lisbon",
  });
  assert.equal(sent.status, 202);
  assert.equal(await title(f.request, agent.id, chat.id), "Plan the trip to Lisbon");
  gateway.runs[gateway.sent[0].idempotencyKey] = { status: "ok" };
  await assistants.reconcile();
  const renamed = await f.request(`/api/assistant-conversations/${chat.id}`, {
    method: "PATCH",
    body: { title: "  Holiday  " },
  });
  assert.equal((await json(renamed, 200)).title, "Holiday");
  await post(f.request, `/api/assistant-conversations/${chat.id}/messages`, {
    clientRequestId: "two",
    text: "Something else entirely",
  });
  assert.equal(await title(f.request, agent.id, chat.id), "Holiday");
  // An empty title restores the automatic one.
  const restored = await f.request(`/api/assistant-conversations/${chat.id}`, {
    method: "PATCH",
    body: { title: "" },
  });
  assert.equal((await json(restored, 200)).title, "Plan the trip to Lisbon");
  for (const body of [{ title: "x".repeat(81) }, { title: "a\nb" }, { name: "x" }]) {
    const refused = await f.request(`/api/assistant-conversations/${chat.id}`, {
      method: "PATCH",
      body,
    });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  // The title never reaches the audit log.
  const audit = JSON.stringify(f.application.audit.list({}));
  assert.doesNotMatch(audit, /Holiday|Lisbon/);
});

test("a chat from before titles is named after its first message", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const chat = await newChat(f.request, agent.id);
  const assistants = f.application.assistants;
  await post(f.request, `/api/assistant-conversations/${chat.id}/messages`, {
    clientRequestId: "one",
    text: "Plan my trip to Rome",
  });
  gateway.runs[gateway.sent[0].idempotencyKey] = { status: "ok" };
  await assistants.reconcile();
  // As stored before this release: history, but no title yet.
  assistants.store.updateConversation(chat.id, { title: null, titleSource: null });
  const sent = await post(f.request, `/api/assistant-conversations/${chat.id}/messages`, {
    clientRequestId: "two",
    text: "ok thanks",
  });
  assert.equal(sent.status, 202);
  assert.equal(await title(f.request, agent.id, chat.id), "Plan my trip to Rome");
});

test("user A cannot rename B's chat", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const benRequest = as(f, ben.cookie);
  const benMain = await openMain(benRequest, agent.id, true);
  const annaRequest = as(f, anna.cookie);
  const refused = await annaRequest(`/api/me/conversations/${benMain}`, {
    method: "PATCH",
    body: { title: "Mine now" },
  });
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), notFoundBody());
  // Nor may the owner rename a user's chat.
  const owner = await f.request(`/api/assistant-conversations/${benMain}`, {
    method: "PATCH",
    body: { title: "Owner's" },
  });
  assert.equal(owner.status, 404);
  const own = await benRequest(`/api/me/conversations/${benMain}`, {
    method: "PATCH",
    body: { title: "Ben's plans" },
  });
  assert.equal((await json(own, 200)).title, "Ben's plans");
});

test("/new opens a new chat instead of resetting", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const request = as(f, anna.cookie);
  const main = await openMain(request, agent.id, true);
  const response = await post(request, `/api/me/conversations/${main}/messages`, {
    clientRequestId: "new-1",
    text: " /new ",
  });
  const { created } = await json(response, 201);
  assert.notEqual(created, main);
  // A retry of the same request opens no second chat.
  const again = await post(request, `/api/me/conversations/${main}/messages`, {
    clientRequestId: "new-1",
    text: "/new",
  });
  assert.equal((await json(again, 201)).created, created);
  assert.equal((await chats(request, agent.id, true)).length, 2);
  // Nothing went to the Gateway as text, and nothing was reset.
  assert.equal(gateway.sent.length, 0);
  assert.ok(!gateway.calls.some((c) => c.method === "sessions.reset"));
  // The owner's chats take /new the same way; /reset is refused.
  const helper = await ownerAgent(f);
  const ownerMain = await openMain(f.request, helper.id);
  const opened = await post(
    f.request,
    `/api/assistant-conversations/${ownerMain}/messages`,
    {
      clientRequestId: "new-2",
      text: "/new",
    },
  );
  assert.equal(opened.status, 201);
  for (const text of ["/reset", "/new please"]) {
    const refused = await post(
      f.request,
      `/api/assistant-conversations/${ownerMain}/messages`,
      { clientRequestId: `cmd-${text}`, text },
    );
    assert.equal(refused.status, 400, text);
    assert.equal((await refused.json()).code, "CHAT_COMMAND");
  }
  assert.equal(gateway.sent.length, 0);
});

test("/name renames", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const request = as(f, anna.cookie);
  const main = await openMain(request, agent.id, true);
  const response = await post(request, `/api/me/conversations/${main}/messages`, {
    clientRequestId: "name-1",
    text: "/name Shopping list",
  });
  assert.equal((await json(response, 200)).chat.title, "Shopping list");
  assert.equal(await title(request, agent.id, main, true), "Shopping list");
  assert.equal(gateway.sent.length, 0);
});
