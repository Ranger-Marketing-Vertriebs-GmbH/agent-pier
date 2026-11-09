import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";
import { cardInput } from "../../server/features/assistants/agent-card-schema.js";

// Ticks and button presses on agent cards (agent-cards.js): the owner on his chats,
// a user on hers, never on each other's.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

const content = cardInput({
  title: "Shopping",
  blocks: [
    { type: "checklist", items: [{ id: "milk", text: "Milk" }] },
    { type: "actions", items: [{ label: "Done", message: "All bought" }] },
  ],
});
const cardIn = (f, conversationId) =>
  f.application.assistants.cards.store.create({
    assistantId:
      f.application.assistants.store.getConversation(conversationId).assistantId,
    conversationId,
    requestId: "r",
    ...content,
    at: new Date().toISOString(),
  });
const post = (request, base, card, kind, body) =>
  request(`${base}/cards/${card.id}/${kind}`, { method: "POST", body });

test("the owner ticks and presses on his chat's card; a user's chat is refused", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f) },
    }),
    201,
  );
  const main = (
    await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
      200,
    )
  ).id;
  const card = cardIn(f, main);
  const base = `/api/assistant-conversations/${main}`;
  const ticked = await json(
    await post(f.request, base, card, "check", {
      version: 1,
      block: 0,
      item: "milk",
      checked: true,
    }),
    200,
  );
  assert.equal(ticked.blocks[0].items[0].checked, true);
  const pressed = await json(
    await post(f.request, base, card, "press", { version: 1, block: 1, item: 0 }),
    200,
  );
  assert.equal(pressed.text, "All bought");
  const stale = await post(f.request, base, card, "check", {
    version: 2,
    block: 0,
    item: "milk",
    checked: false,
  });
  assert.equal(stale.status, 409);
  const invalid = await post(f.request, base, card, "check", { version: "1" });
  assert.equal(invalid.status, 400);
  const missing = await f.request(`${base}/cards/card_missing/check`, {
    method: "POST",
    body: { version: 1, block: 0, item: "milk", checked: true },
  });
  assert.equal(missing.status, 404);

  const { user, cookie } = await signedInUser(f, "Anna");
  const hers = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const annaMain = (
    await json(
      await as(f, cookie)(`/api/me/agents/${hers.id}/conversation`, { method: "POST" }),
      200,
    )
  ).id;
  const annaCard = cardIn(f, annaMain);
  const refused = await post(
    f.request,
    `/api/assistant-conversations/${annaMain}`,
    annaCard,
    "check",
    { version: 1, block: 0, item: "milk", checked: true },
  );
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), notFoundBody());

  // She ticks her own card; the owner's card is not hers to reach.
  const anna = as(f, cookie);
  const mine = await json(
    await post(anna, `/api/me/conversations/${annaMain}`, annaCard, "check", {
      version: 1,
      block: 0,
      item: "milk",
      checked: true,
    }),
    200,
  );
  assert.equal(mine.blocks[0].items[0].checked, true);
  const foreign = await post(anna, `/api/me/conversations/${main}`, card, "press", {
    version: 1,
    block: 1,
    item: 0,
  });
  assert.equal(foreign.status, 404);
  const crossed = await post(anna, `/api/me/conversations/${annaMain}`, card, "press", {
    version: 1,
    block: 1,
    item: 0,
  });
  assert.equal(crossed.status, 404);
});
