import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { shareFixture } from "../helpers/agent-share-fixture.js";
import { AgentPinboard } from "../../server/features/assistants/agent-pinboard.js";
import { forgetChat } from "../../server/features/assistants/chat-removal.js";

async function setup(t) {
  const f = await shareFixture(t);
  f.service.pinboard = new AgentPinboard({ assistants: f.service });
  const invoke = (invocation, input) =>
    f.service.pinboard.invoke(
      { toolCallId: randomUUID(), assertCurrent() {}, ...invocation },
      input,
    );
  const inTurn = async (chat, key) => {
    const attempt = await f.turn(chat, key);
    return (input) => invoke({ attemptId: attempt.id }, input);
  };
  const pinned = async (call, listId, name) => {
    f.file(f.agent, name, `# ${name}\n`);
    await call({ action: "pin", listId, path: name });
  };
  const cards = async (chat) =>
    (await f.service.history(chat.id)).messages.filter((m) => m.pinboard);
  return { ...f, invoke, inTurn, pinned, cards };
}

test("a turn's pins show as one card per list in the history", async (t) => {
  const f = await setup(t);
  const call = await f.inTurn(f.chat, "turn-1");
  const a = (await call({ action: "create_list", title: "Episodes" })).list.id;
  const b = (await call({ action: "create_list", title: "Notes" })).list.id;
  await f.pinned(call, a, "ep1.md");
  await f.pinned(call, a, "ep1.md");
  await f.pinned(call, a, "ep1.md");
  await f.pinned(call, b, "n1.md");
  const cards = await f.cards(f.chat);
  assert.equal(cards.length, 2);
  const card = (title) => cards.find((m) => m.pinboard.title === title);
  const episodes = card("Episodes");
  assert.equal(episodes.pinboard.added, 1);
  assert.equal(episodes.pinboard.updated, 2);
  assert.equal(card("Notes").pinboard.added, 1);
  assert.deepEqual(episodes.pinboard.names, ["ep1.md"]);
  assert.match(episodes.id, new RegExp(`^pinboard:${a}:.+`));
  assert.equal(episodes.id, `pinboard:${a}:${episodes.requestId}`);
  assert.equal(episodes.role, "assistant");
  assert.equal(episodes.text, "");
  assert.equal(episodes.runId, null);
  assert.equal(typeof episodes.timestamp, "number");
  assert.equal(episodes.pinboard.gone, false);
  // Ordered by time among the turn's other messages.
  const ts = cards.map((m) => m.timestamp);
  assert.deepEqual(
    ts,
    [...ts].sort((x, y) => x - y),
  );
});

test("a deleted list keeps its card, marked gone", async (t) => {
  const f = await setup(t);
  const call = await f.inTurn(f.chat, "turn-1");
  const id = (await call({ action: "create_list", title: "Old" })).list.id;
  await f.pinned(call, id, "x.md");
  await call({ action: "update_list", listId: id, title: "Renamed" });
  assert.equal((await f.cards(f.chat))[0].pinboard.title, "Renamed");
  await call({ action: "delete_list", listId: id });
  const [card] = await f.cards(f.chat);
  assert.equal(card.pinboard.gone, true);
  assert.equal(card.pinboard.title, "Old");
  assert.equal(card.pinboard.added, 1);
});

test("a routine's pin shows in the list's origin chat, or the main chat when that chat is gone", async (t) => {
  const f = await setup(t);
  const main = f.store.updateConversation(f.chat.id, { main: true });
  const other = f.store.saveConversation({
    assistantId: f.agent.id,
    runtimeSessionKey: "other",
  });
  const call = await f.inTurn(other, "turn-1");
  const id = (await call({ action: "create_list", title: "Daily" })).list.id;
  const routine = (conversation, run) =>
    f.invoke(
      {
        routine: { binding: { id: "binding-1" }, conversation: main },
        sessionKey: run,
      },
      conversation,
    );
  f.file(f.agent, "a.md", "a");
  await routine({ action: "pin", listId: id, path: "a.md" }, "s1");
  assert.equal((await f.cards(other)).length, 1);
  assert.equal((await f.cards(main)).length, 0);
  f.store.updateConversation(other.id, { archivedAt: new Date().toISOString() });
  f.file(f.agent, "b.md", "b");
  await routine({ action: "pin", listId: id, path: "b.md" }, "s2");
  const [card] = await f.cards(main);
  assert.deepEqual(card.pinboard.names, ["b.md"]);
});

test("the chat feed of the card's chat is invalidated", async (t) => {
  const f = await setup(t);
  const call = await f.inTurn(f.chat, "turn-1");
  const id = (await call({ action: "create_list", title: "Episodes" })).list.id;
  const seen = [];
  f.service.events.on("conversation", (chat) => seen.push(chat));
  await f.pinned(call, id, "ep1.md");
  assert.ok(seen.includes(f.chat.id));
});

test("cards sit among the chat's messages by time", async (t) => {
  const f = await setup(t);
  const call = await f.inTurn(f.chat, "turn-1");
  const id = (await call({ action: "create_list", title: "Episodes" })).list.id;
  await f.pinned(call, id, "ep1.md");
  const now = Date.now();
  const reply = (text, timestamp) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    __openclaw: { id: text },
  });
  f.setHistory([reply("before", now - 60_000), reply("after", now + 60_000)]);
  const messages = (await f.service.history(f.chat.id)).messages;
  const order = messages.map((m) => (m.pinboard ? "card" : m.text));
  assert.ok(
    ["before", "card", "after"].every((name) => order.includes(name)),
    order,
  );
  assert.ok(order.indexOf("before") < order.indexOf("card"));
  assert.ok(order.indexOf("card") < order.indexOf("after"));
});

test("a list's title is read once per history, whatever its changes", async (t) => {
  const f = await setup(t);
  const store = f.service.pinboard.store;
  const lookups = [];
  const title = store.listTitle.bind(store);
  store.listTitle = (...args) => (lookups.push(args[1]), title(...args));
  const call = await f.inTurn(f.chat, "turn-1");
  const listId = (await call({ action: "create_list", title: "Episodes" })).list.id;
  await f.pinned(call, listId, "ep1.md");
  // Two more turns' changes of the same list.
  for (const requestId of ["r2", "r3"])
    store.recordChange({
      conversationId: f.chat.id,
      requestId,
      listId,
      assistantId: f.agent.id,
      title: "Episodes",
      at: new Date().toISOString(),
      kind: "added",
      name: `${requestId}.md`,
    });
  lookups.length = 0;
  const cards = await f.cards(f.chat);
  assert.equal(cards.length, 3);
  assert.ok(cards.every((card) => card.pinboard.title === "Episodes"));
  assert.deepEqual(lookups, [listId]);
});

test("a deleted chat's cards go with it", async (t) => {
  const f = await setup(t);
  const other = f.store.saveConversation({
    assistantId: f.agent.id,
    runtimeSessionKey: "other",
  });
  for (const chat of [f.chat, other]) {
    const call = await f.inTurn(chat, `turn-${chat.id}`);
    const id = (await call({ action: "create_list", title: chat.id })).list.id;
    await f.pinned(call, id, "ep1.md");
  }
  await forgetChat(f.service, other);
  const store = f.service.pinboard.store;
  assert.deepEqual(store.changesFor(other.id), []);
  assert.equal(store.changesFor(f.chat.id).length, 1);
});
