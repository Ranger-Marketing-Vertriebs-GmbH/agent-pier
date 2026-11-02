import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";

// The hint in an older chat whose last turns ran on another model family than the
// agent uses now (server/features/assistants/model-hints.js). The fixture runs
// openai/gpt-4.1-mini on OpenRouter: family "openai".

async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function shared(t) {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const service = f.application.assistants;
  const annaRequest = as(f, anna.cookie);
  const benRequest = as(f, ben.cookie);
  const main = async (request, id) =>
    json(await request(`/api/me/agents/${id}/conversation`, { method: "POST" }));
  // Her first chat is her main chat; the next is an older one.
  const extra = async (request) => {
    await main(request, agent.id);
    return json(
      await request(`/api/me/agents/${agent.id}/chats`, { method: "POST" }),
      201,
    );
  };
  return { f, service, agent, annaRequest, benRequest, main, extra };
}

const send = (request, id, clientRequestId) =>
  request(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId, text: "Hello" },
  });
const read = async (request, id) =>
  json(await request(`/api/me/conversations/${id}/messages`));

test("an older chat shows the hint after a family switch", async (t) => {
  const { service, annaRequest, extra } = await shared(t);
  const chat = await extra(annaRequest);
  assert.equal("modelHint" in (await read(annaRequest, chat.id)), false);
  const sent = await send(annaRequest, chat.id, "first");
  assert.ok(sent.status < 300, await sent.clone().text());
  // The turn recorded the family it ran on; the same family shows no hint.
  assert.equal(service.store.getConversation(chat.id).family, "openai");
  assert.equal("modelHint" in (await read(annaRequest, chat.id)), false);
  service.store.updateConversation(chat.id, { family: "anthropic" });
  assert.equal((await read(annaRequest, chat.id)).modelHint, true);
});

test("main chats never show it", async (t) => {
  const { service, agent, annaRequest, main } = await shared(t);
  const chat = await main(annaRequest, agent.id);
  assert.equal(service.store.getConversation(chat.id).main, true);
  service.store.updateConversation(chat.id, { family: "anthropic" });
  assert.equal("modelHint" in (await read(annaRequest, chat.id)), false);
});

test("dismissal is per person", async (t) => {
  const { service, annaRequest, benRequest, extra } = await shared(t);
  const annas = await extra(annaRequest);
  const bens = await extra(benRequest);
  for (const chat of [annas, bens])
    service.store.updateConversation(chat.id, { family: "anthropic" });
  await json(
    await annaRequest(`/api/me/conversations/${annas.id}/model-hint-dismissal`, {
      method: "POST",
    }),
  );
  assert.equal("modelHint" in (await read(annaRequest, annas.id)), false);
  assert.equal((await read(benRequest, bens.id)).modelHint, true);
  // Another user's chat is the unknown route.
  const foreign = await annaRequest(
    `/api/me/conversations/${bens.id}/model-hint-dismissal`,
    {
      method: "POST",
    },
  );
  assert.equal(foreign.status, 404);
  // A new switch brings the hint back: the dismissal named one pair of families.
  service.store.updateConversation(annas.id, { family: "google" });
  assert.equal((await read(annaRequest, annas.id)).modelHint, true);
});

test("a user never sees the owner's dismissal state", async (t) => {
  const { f, service, agent, annaRequest, extra } = await shared(t);
  const annas = await extra(annaRequest);
  await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" });
  const owners = await json(
    await f.request(`/api/assistants/${agent.id}/chats`, {
      method: "POST",
    }),
    201,
  );
  for (const chat of [annas, owners])
    service.store.updateConversation(chat.id, { family: "anthropic" });
  const hidden = await json(
    await f.request(`/api/assistant-conversations/${owners.id}/model-hint-dismissal`, {
      method: "POST",
    }),
  );
  assert.deepEqual(hidden, { dismissed: true });
  const ownerView = await json(
    await f.request(`/api/assistant-conversations/${owners.id}/messages`),
  );
  assert.equal("modelHint" in ownerView, false);
  assert.equal((await read(annaRequest, annas.id)).modelHint, true);
});
