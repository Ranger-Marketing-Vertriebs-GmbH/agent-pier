import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerChatsOf,
  paneDraggable,
  resolveAgentChat,
} from "../../web/features/assistants/agent-chat-target.js";

const models = [{ id: "router", available: true }];
const a1 = { id: "a1", model: { connectionId: "router", modelId: "m" } };

test("an owner's agent with a connection can be dragged into a view", () => {
  assert.equal(paneDraggable(a1, models), true);
});

test("team members, users' own agents, archived agents and agents without a connection cannot", () => {
  assert.equal(paneDraggable({ id: "a2", teamMemberId: "m1", model: {} }, models), false);
  assert.equal(paneDraggable({ ...a1, id: "a2b", teamMemberId: "m1" }, models), false);
  assert.equal(
    paneDraggable({ id: "a3", userAccess: { mode: "own" }, model: {} }, models),
    false,
  );
  assert.equal(
    paneDraggable({ ...a1, id: "a3b", userAccess: { mode: "own" } }, models),
    false,
  );
  assert.equal(paneDraggable({ ...a1, archivedAt: "2026-11-01" }, models), false);
  assert.equal(
    paneDraggable({ ...a1, model: { connectionId: "gone", modelId: "m" } }, models),
    false,
  );
});

test("the owner's chats: main first, then the most recently active", () => {
  const chats = ownerChatsOf(a1, [
    { id: "old", assistantId: "a1", lastActivityAt: "2026-10-01" },
    { id: "new", assistantId: "a1", lastActivityAt: "2026-10-30" },
    { id: "main", assistantId: "a1", main: true, lastActivityAt: "2026-09-01" },
    { id: "other", assistantId: "a2" },
    { id: "archived", assistantId: "a1", archivedAt: "2026-10-31" },
    { id: "telegram", assistantId: "a1", channel: "telegram" },
    { id: "user", assistantId: "a1", userId: "u1" },
  ]);
  assert.deepEqual(
    chats.map((chat) => chat.id),
    ["main", "new", "old"],
  );
});

test("an agent with a chat resolves to its first one without opening", async () => {
  assert.equal(
    await resolveAgentChat(a1, {
      conversations: [{ id: "c1", assistantId: "a1", main: true }],
      open: () => assert.fail(),
    }),
    "c1",
  );
});

test("an agent without a chat opens one and refreshes, as a click does", async () => {
  const calls = [];
  assert.equal(
    await resolveAgentChat(a1, {
      conversations: [],
      open: async (id) => {
        calls.push(`open:${id}`);
        return { id: "c9" };
      },
      refresh: async () => {
        calls.push("refresh");
      },
    }),
    "c9",
  );
  assert.deepEqual(calls, ["open:a1", "refresh"]);
  assert.equal(
    await resolveAgentChat(a1, {
      conversations: [],
      open: async () => ({ id: "c9" }),
      refresh: async () => {},
    }),
    "c9",
  );
});
