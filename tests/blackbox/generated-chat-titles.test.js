import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, userAgent, as } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { chatTitleMethod } from "../../server/features/assistants/team-plugin/chat-title.js";

// AGENTPIER-187: once a chat's first written turn has its reply, the agent's own model
// names the chat (generated-titles.js). The Gateway is scripted: `answer` stands in
// for the plugin's title method.

async function ownerAgent(f) {
  const response = await f.request("/api/assistants", {
    method: "POST",
    body: { name: "Helper", instructions: "", model: fixtureModel(f) },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function newChat(request, agentId, user) {
  const response = await request(
    user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`,
    { method: "POST" },
  );
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function chatList(request, agentId, user) {
  const response = await request(
    user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`,
  );
  assert.equal(response.status, 200);
  return response.json();
}

// Every title request reaches `answer` and is recorded.
function titles(gateway, answer = async () => ({ title: "Trip to Lisbon" })) {
  const asked = [];
  const call = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    if (method !== chatTitleMethod) return call(method, params, options);
    asked.push(params);
    return answer(params);
  };
  return asked;
}

// The turn's run ends with `reply` in the chat's history.
async function reply(f, gateway, chatId, reply, index = gateway.sent.length - 1) {
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(chatId).runtimeSessionKey;
  const runId = gateway.sent[index].idempotencyKey;
  const history = (gateway.history[key] ??= []);
  history.push(
    {
      role: "user",
      content: gateway.sent[index].message,
      timestamp: 1000 + history.length,
      __openclaw: { id: `u-${runId}` },
    },
    ...(reply === null
      ? []
      : [
          {
            role: "assistant",
            content: [{ type: "text", text: reply }],
            timestamp: 1001 + history.length,
            __openclaw: { id: `a-${runId}`, runId },
          },
        ]),
  );
  gateway.runs[runId] = { status: "ok" };
  await assistants.reconcile();
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function send(request, chatId, text, id = text) {
  const response = await request(`/api/assistant-conversations/${chatId}/messages`, {
    method: "POST",
    body: { clientRequestId: id, text },
  });
  assert.equal(response.status, 202, await response.clone().text());
}

test("the agent names a chat once after its first reply", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const asked = titles(gateway, async () => ({ title: '**Title:** "Trip to Lisbon."' }));
  const agent = await ownerAgent(f);
  const chat = await newChat(f.request, agent.id);
  const assistants = f.application.assistants;
  let changes = 0;
  assistants.events.on("conversation", (id) => (changes += id === chat.id));
  await send(f.request, chat.id, "Plan the trip to Lisbon in May, please");
  // Until the reply the first message names it.
  assert.equal(
    (await chatList(f.request, agent.id)).find((c) => c.id === chat.id).title,
    "Plan the trip to Lisbon in May, please",
  );
  assert.deepEqual(asked, []);
  const requests = assistants.ledger.requests(chat.id).length;
  const calls = gateway.calls.length;
  await reply(f, gateway, chat.id, "Gladly! Alfama and Baixa are lovely.");
  await settle();
  assert.deepEqual(asked, [
    {
      agentId: agent.runtimeAgentId,
      message: "Plan the trip to Lisbon in May, please",
      reply: "Gladly! Alfama and Baixa are lovely.",
    },
  ]);
  const listed = (await chatList(f.request, agent.id)).find((c) => c.id === chat.id);
  assert.equal(listed.title, "Trip to Lisbon");
  assert.equal(assistants.store.storedConversation(chat.id).titleSource, "generated");
  // Open lists heard of it.
  assert.ok(changes >= 1);
  // The title was no turn: nothing sent, created or recorded besides the request.
  assert.equal(assistants.ledger.requests(chat.id).length, requests);
  assert.deepEqual(
    gateway.calls
      .slice(calls)
      .map((c) => c.method)
      .filter((m) => ["sessions.send", "sessions.create", "chat.send"].includes(m)),
    [],
  );
  const history = await (
    await f.request(`/api/assistant-conversations/${chat.id}/messages`)
  ).json();
  assert.equal(history.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(history), /Trip to Lisbon/);
  // Later turns never ask again.
  await send(f.request, chat.id, "And in June?");
  await reply(f, gateway, chat.id, "Also fine.");
  await settle();
  assert.equal(asked.length, 1);
  // A rename wins, and "" brings back the generated title.
  for (const [value, expected] of [
    ["Holiday", "Holiday"],
    ["", "Trip to Lisbon"],
  ]) {
    const renamed = await f.request(`/api/assistant-conversations/${chat.id}`, {
      method: "PATCH",
      body: { title: value },
    });
    assert.equal((await renamed.json()).title, expected);
  }
  // Neither text reaches the audit log.
  assert.doesNotMatch(JSON.stringify(f.application.audit.list({})), /Lisbon|Alfama/);
});

test("a rename while the model answers wins", async (t) => {
  const { f, gateway } = await chatFixture(t);
  let answer;
  const asked = titles(gateway, () => new Promise((resolve) => (answer = resolve)));
  const agent = await ownerAgent(f);
  const chat = await newChat(f.request, agent.id);
  await send(f.request, chat.id, "Compare the kitchen offers");
  await reply(f, gateway, chat.id, "Offer B is cheapest.");
  await settle();
  assert.equal(asked.length, 1);
  const renamed = await f.request(`/api/assistant-conversations/${chat.id}`, {
    method: "PATCH",
    body: { title: "Kitchen" },
  });
  assert.equal(renamed.status, 200);
  answer({ title: "Kitchen offer comparison" });
  await settle();
  const stored = f.application.assistants.store.storedConversation(chat.id);
  assert.equal(stored.title, "Kitchen");
  assert.equal(stored.titleSource, "set");
});

test("a failed, empty or rambling answer keeps the first-message title", async (t) => {
  for (const answer of [
    async () => {
      throw Object.assign(Error("Assistant Gateway unavailable"), { code: "TIMEOUT" });
    },
    async () => ({ title: "" }),
    async () => ({
      title: "Okay, the user wants to plan a trip and I should think first",
    }),
    async () => ({}),
  ]) {
    const { f, gateway } = await chatFixture(t);
    const asked = titles(gateway, answer);
    const warnings = [];
    t.mock.method(console, "warn", (line) => warnings.push(line));
    const agent = await ownerAgent(f);
    const chat = await newChat(f.request, agent.id);
    await send(f.request, chat.id, "Plan the trip to Lisbon");
    await reply(f, gateway, chat.id, "Gladly, the secret plan is ready.");
    await settle();
    assert.equal(asked.length, 1);
    const stored = f.application.assistants.store.storedConversation(chat.id);
    assert.equal(stored.title, "Plan the trip to Lisbon");
    assert.equal(stored.titleSource, "auto");
    // A diagnostic without either text or the answer.
    const logged = warnings.filter((w) => String(w).includes(chat.id));
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], /Lisbon|secret|Okay/);
    t.mock.restoreAll();
  }
});

test("no title without a reply, nor from a routine, team or forwarded turn", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const asked = titles(gateway);
  const agent = await ownerAgent(f);
  const assistants = f.application.assistants;
  // The first turn failed: no reply to name it from.
  const failed = await newChat(f.request, agent.id);
  await send(f.request, failed.id, "Plan the trip to Lisbon");
  gateway.runs[gateway.sent.at(-1).idempotencyKey] = { status: "error" };
  await assistants.reconcile();
  // The run ended without any reply.
  const silent = await newChat(f.request, agent.id);
  await send(f.request, silent.id, "Plan the trip to Rome");
  await reply(f, gateway, silent.id, null);
  // Scheduled and team turns are not her writing, nor is a forwarded message.
  for (const context of [
    { kind: "routine" },
    { kind: "team" },
    { kind: "telegram", forwarded: true },
  ]) {
    const chat = await newChat(f.request, agent.id);
    await assistants.send(
      chat.id,
      { clientRequestId: `turn-${context.kind}`, text: "Report on the weather" },
      context,
    );
    await reply(f, gateway, chat.id, "Sunny all week.");
  }
  await settle();
  assert.deepEqual(asked, []);
});

test("a user's chat is named on her agent's model and stays hers", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const asked = titles(gateway, async () => ({ title: "Anna's garden plan" }));
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "personalize" }],
  });
  const request = as(f, anna.cookie);
  const chat = await newChat(request, agent.id, true);
  const sent = await request(`/api/me/conversations/${chat.id}/messages`, {
    method: "POST",
    body: { clientRequestId: "one", text: "Plan my garden beds" },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  await reply(f, gateway, chat.id, "Start with tomatoes.");
  await settle();
  assert.deepEqual(
    asked.map((a) => a.agentId),
    [agent.runtimeAgentId],
  );
  assert.equal(
    (await chatList(request, agent.id, true)).find((c) => c.id === chat.id).title,
    "Anna's garden plan",
  );
  // The owner's lists never show it without her opt-in.
  const owner = await (await f.request("/api/assistants")).text();
  assert.doesNotMatch(owner, /garden/);
});
