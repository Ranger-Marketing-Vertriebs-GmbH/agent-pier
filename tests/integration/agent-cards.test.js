import test from "node:test";
import assert from "node:assert/strict";
import { cardsFixture, plan } from "../helpers/agent-cards-fixture.js";
import { forgetChat } from "../../server/features/assistants/chat-removal.js";

test("a turn creates a card that shows in its chat's history", async (t) => {
  const f = await cardsFixture(t);
  await f.turn(f.chat, "turn-1");
  const created = await f.card(f.chat, { action: "create", ...plan });
  assert.equal(created.status, "created");
  assert.equal(created.version, 1);
  assert.match(created.note, /owner sees this card/);
  assert.equal(created.telegram, undefined);
  const [item] = await f.cards(f.chat);
  assert.equal(item.id, `card:${created.cardId}:1`);
  assert.equal(item.role, "assistant");
  assert.equal(item.card.title, "Dinners week 46");
  assert.deepEqual(
    item.card.blocks[1].items.map((i) => i.checked),
    [false, false],
  );
  assert.deepEqual(
    f.audit.filter((e) => e.details.kind === "card").map((e) => e.details.card),
    ["create"],
  );
});

test("an update moves the card and leaves a marker at its old place", async (t) => {
  const f = await cardsFixture(t);
  const first = await f.turn(f.chat, "turn-1");
  const { cardId } = await f.card(f.chat, { action: "create", ...plan });
  f.settle(first);
  await f.turn(f.chat, "turn-2");
  const updated = await f.card(f.chat, {
    action: "update",
    cardId,
    blocks: [{ type: "text", text: "Swapped Tuesday" }],
  });
  assert.equal(updated.status, "updated");
  assert.equal(updated.version, 2);
  const [marker, card] = await f.cards(f.chat);
  assert.equal(marker.id, `card:${cardId}:1`);
  assert.deepEqual(marker.cardMoved, { id: cardId, title: "Dinners week 46" });
  assert.equal(card.id, `card:${cardId}:2`);
  assert.equal(card.card.version, 2);
  assert.ok(card.timestamp >= marker.timestamp);
  const read = await f.card(f.chat, { action: "read", cardId });
  assert.equal(read.card.blocks[0].text, "Swapped Tuesday");
});

test("a card of another chat, or of a deleted chat, is not found", async (t) => {
  const f = await cardsFixture(t);
  await f.turn(f.chat, "turn-1");
  const { cardId } = await f.card(f.chat, { action: "create", ...plan });
  const other = f.store.saveConversation({
    assistantId: f.agent.id,
    runtimeSessionKey: "other",
  });
  await f.turn(other, "turn-other");
  const refused = await f.card(other, { action: "update", cardId, blocks: plan.blocks });
  assert.equal(refused.code, "CARD_NOT_FOUND");
  assert.deepEqual((await f.card(other, { action: "read" })).cards, []);
  await forgetChat(f.service, f.store.getConversation(f.chat.id));
  assert.equal(f.service.cards.store.get(cardId), null);
});

test("ticks are silent; the next turn carries a card note the history leaves out", async (t) => {
  const f = await cardsFixture(t);
  const first = await f.turn(f.chat, "turn-1");
  const { cardId } = await f.card(f.chat, { action: "create", ...plan });
  f.settle(first);
  const sentBefore = f.sent.length;
  const view = f.service.cards.check(f.chat.id, cardId, {
    version: 1,
    block: 1,
    item: "milk",
    checked: true,
  });
  assert.equal(view.blocks[1].items[0].checked, true);
  assert.equal(f.sent.length, sentBefore, "a tick starts no turn");
  const press = f.service.cards.press(f.chat.id, cardId, {
    version: 1,
    block: 0,
    row: 0,
  });
  assert.equal(press.text, "Swap: Tue · Lasagne");
  await f.service.send(
    f.chat.id,
    { clientRequestId: "turn-2", text: press.text },
    { kind: "owner" },
  );
  const message = f.sent.at(-1);
  assert.ok(message.startsWith("Swap: Tue · Lasagne\n\n[AgentPier card state"));
  assert.match(message, new RegExp(`cardId ${cardId}, version 1`));
  assert.match(message, /checklist "Shopping": done "Milk"; open "Rice"/);
  assert.match(message, /pressed "Swap" on row "Tue · Lasagne"/);
  // Seen now: the turn after carries no note.
  assert.equal(f.service.cards.turnNote(f.chat.id), null);
  f.setHistory([
    { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() },
  ]);
  const history = await f.service.history(f.chat.id);
  const user = history.messages.find((m) => m.role === "user");
  assert.equal(user.text, "Swap: Tue · Lasagne");
});

test("a stale or frozen card refuses ticks and presses", async (t) => {
  const f = await cardsFixture(t);
  await f.turn(f.chat, "turn-1");
  const { cardId } = await f.card(f.chat, { action: "create", ...plan });
  await f.card(f.chat, { action: "update", cardId, blocks: plan.blocks });
  assert.throws(
    () =>
      f.service.cards.check(f.chat.id, cardId, {
        version: 1,
        block: 1,
        item: "milk",
        checked: true,
      }),
    (error) => error.code === "CARD_CHANGED" && error.status === 409,
  );
  assert.throws(
    () => f.service.cards.check("other", cardId, { version: 2, block: 1, item: "milk" }),
    (error) => error.code === "CARD_NOT_FOUND",
  );
});

test("a Telegram turn's new card goes to Telegram as text; its update does not", async (t) => {
  const f = await cardsFixture(t);
  await f.turn(f.chat, "telegram", {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  });
  const created = await f.card(f.chat, { action: "create", ...plan });
  assert.equal(created.telegram, "queued");
  await f.card(f.chat, { action: "update", cardId: created.cardId, blocks: plan.blocks });
  const cards = f.channels.outbox
    .all(f.channel.id)
    .filter((entry) => entry.kind === "agent-card");
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /^Dinners week 46\n\nTue · Lasagne\n\nShopping\n☐ Milk/);
  assert.match(cards[0].text, /Open the chat in AgentPier to use this card\.$/);
});

test("a team member's run gets no cards, and invalid blocks name their part", async (t) => {
  const f = await cardsFixture(t);
  await f.turn(f.chat, "turn-1");
  const bad = await f.card(f.chat, {
    action: "create",
    title: "x",
    blocks: [{ type: "table", rows: [{ cells: ["a"], action: { label: "" } }] }],
  });
  assert.equal(bad.code, "CARD_INVALID");
  assert.match(bad.reason, /blocks\[0\]\.rows\[0\]\.action\.label/);
  const checked = await f.card(f.chat, {
    action: "create",
    title: "x",
    blocks: [{ type: "links", items: [{ label: "a", url: "file:///etc/passwd" }] }],
  });
  assert.equal(checked.code, "CARD_INVALID");
  assert.match(checked.reason, /blocks\[0\]\.items\[0\]\.url/);
  f.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body, '$.teamMemberId', 'team-1') WHERE id=?",
    )
    .run(f.agent.id);
  const member = await f.card(f.chat, { action: "create", ...plan });
  assert.equal(member.code, "CARD_UNAVAILABLE");
});
