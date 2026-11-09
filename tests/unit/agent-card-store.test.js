import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentCardStore } from "../../server/features/assistants/agent-card-store.js";
import {
  CARD_LIMITS,
  cardInput,
} from "../../server/features/assistants/agent-card-schema.js";

const at = (minute) => `2026-11-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
const content = cardInput({
  title: "Dinners",
  blocks: [
    { type: "table", rows: [{ cells: ["Tue", "Lasagne"], action: { label: "Swap" } }] },
    { type: "checklist", items: [{ id: "milk", text: "Milk" }] },
    { type: "actions", items: [{ label: "Recipes", message: "Recipes for Monday" }] },
  ],
});
const setup = () => {
  const store = new AgentCardStore(new DatabaseSync(":memory:"));
  const card = store.create({
    assistantId: "a",
    conversationId: "chat",
    requestId: "r1",
    ...content,
    at: at(0),
  });
  return { store, card };
};
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("a card is created in its chat and found only there", () => {
  const { store, card } = setup();
  assert.match(card.id, /^card_/);
  assert.equal(card.version, 1);
  assert.deepEqual(card.placements, [{ at: at(0), requestId: "r1" }]);
  assert.equal(store.inChat("chat", card.id).title, "Dinners");
  fails(() => store.inChat("other", card.id), "CARD_NOT_FOUND");
  fails(() => store.inChat("chat", "card_missing"), "CARD_NOT_FOUND");
});

test("an update is a new version placed again; a stale version is refused", () => {
  const { store, card } = setup();
  const next = store.update(card, {
    ...content,
    title: "Dinners v2",
    requestId: "r2",
    at: at(5),
  });
  assert.equal(next.version, 2);
  assert.equal(next.title, "Dinners v2");
  assert.deepEqual(
    next.placements.map((p) => p.requestId),
    ["r1", "r2"],
  );
  fails(
    () => store.update(card, { ...content, requestId: "r3", at: at(6) }),
    "CARD_CHANGED",
  );
  let latest = next;
  for (let i = 0; i < CARD_LIMITS.placements + 5; i++)
    latest = store.update(latest, { ...content, requestId: `x${i}`, at: at(10) });
  assert.equal(latest.placements.length, CARD_LIMITS.placements);
});

test("ticks are silent changes the agent sees once", () => {
  const { store, card } = setup();
  assert.deepEqual(store.changedFor("chat"), []);
  const ticked = store.check(card, {
    version: 1,
    block: 1,
    item: "milk",
    checked: true,
    at: at(1),
  });
  assert.equal(ticked.blocks[1].items[0].checked, true);
  assert.equal(ticked.version, 1);
  assert.deepEqual(
    store.changedFor("chat").map((c) => c.id),
    [card.id],
  );
  store.seen([store.get(card.id)], at(2));
  assert.deepEqual(store.changedFor("chat"), []);
  fails(
    () =>
      store.check(ticked, {
        version: 2,
        block: 1,
        item: "milk",
        checked: false,
        at: at(3),
      }),
    "CARD_CHANGED",
  );
  fails(
    () =>
      store.check(ticked, {
        version: 1,
        block: 0,
        item: "milk",
        checked: false,
        at: at(3),
      }),
    "CARD_CHANGED",
  );
});

test("a press names its message and is remembered until the agent sees it", () => {
  const { store, card } = setup();
  const row = store.press(card, { version: 1, block: 0, row: 0, at: at(1) });
  assert.equal(row.text, "Swap: Tue · Lasagne");
  assert.deepEqual(row.card.pressed, { label: "Swap", row: "Tue · Lasagne", at: at(1) });
  const button = store.press(row.card, { version: 1, block: 2, item: 0, at: at(2) });
  assert.equal(button.text, "Recipes for Monday");
  fails(
    () => store.press(card, { version: 1, block: 1, item: 0, at: at(3) }),
    "CARD_CHANGED",
  );
  store.seen([store.get(card.id)], at(4));
  assert.equal(store.get(card.id).pressed, null);
});

test("beyond the open limit the oldest cards freeze and refuse changes", () => {
  const { store, card } = setup();
  for (let i = 1; i <= CARD_LIMITS.openCards; i++)
    store.create({
      assistantId: "a",
      conversationId: "chat",
      requestId: `r${i}`,
      ...content,
      at: at(i % 60),
    });
  const frozen = store.get(card.id);
  assert.ok(frozen.frozenAt);
  assert.equal(store.forConversation("chat").filter((c) => !c.frozenAt).length, 30);
  fails(
    () => store.update(frozen, { ...content, requestId: "z", at: at(59) }),
    "CARD_FROZEN",
  );
  fails(
    () =>
      store.check(frozen, {
        version: 1,
        block: 1,
        item: "milk",
        checked: true,
        at: at(59),
      }),
    "CARD_FROZEN",
  );
});

test("notes and cards go with their chat", () => {
  const { store } = setup();
  store.recordNote({
    conversationId: "chat",
    requestId: "r9",
    assistantId: "a",
    note: "N",
  });
  assert.deepEqual(store.notes("chat"), ["N"]);
  store.forgetConversation("chat");
  assert.deepEqual(store.forConversation("chat"), []);
  assert.deepEqual(store.notes("chat"), []);
});

test("a tick or press after the seen time stays new", () => {
  const { store, card } = setup();
  const ticked = store.check(card, {
    version: 1,
    block: 1,
    item: "milk",
    checked: true,
    at: at(1),
  });
  const noted = store.get(card.id);
  store.press(ticked, { version: 1, block: 2, item: 0, at: at(3) });
  // The note was built at minute 2, before the press.
  store.seen([noted], at(2));
  const after = store.get(card.id);
  assert.equal(after.pressed.at, at(3));
  assert.deepEqual(after.seenTicks, { "checklist/milk": true });
  assert.deepEqual(
    store.changedFor("chat").map((c) => c.id),
    [card.id],
  );
});

test("a press whose message failed is forgotten", () => {
  const { store, card } = setup();
  const { card: pressed } = store.press(card, {
    version: 1,
    block: 2,
    item: 0,
    at: at(1),
  });
  assert.equal(store.unpress(pressed, at(9)).pressed.at, at(1), "another press stays");
  assert.equal(store.unpress(pressed, at(1)).pressed, null);
});

test("a chat keeps at most keptCards cards; the oldest frozen go first", () => {
  const { store, card } = setup();
  for (let i = 1; i < CARD_LIMITS.keptCards + 5; i++)
    store.create({
      assistantId: "a",
      conversationId: "chat",
      requestId: `r${i}`,
      ...content,
      at: `2026-11-09T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
    });
  const kept = store.forConversation("chat");
  assert.equal(kept.length, CARD_LIMITS.keptCards);
  assert.equal(kept.filter((c) => !c.frozenAt).length, CARD_LIMITS.openCards);
  assert.equal(store.get(card.id), null);
  assert.equal(
    store.createdSince("chat", "2026-11-09T11:00:00.000Z"),
    CARD_LIMITS.keptCards,
  );
});
