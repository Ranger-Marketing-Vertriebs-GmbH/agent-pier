import test from "node:test";
import assert from "node:assert/strict";
import { agentChats } from "../../web/features/dashboard/useOpenAgent.js";

const chats = [
  { id: "old", assistantId: "a", createdAt: "2026-10-01T00:00:00Z" },
  { id: "recent", assistantId: "a", lastActivityAt: "2026-10-27T00:00:00Z" },
  { id: "main", assistantId: "a", main: true, createdAt: "2026-09-01T00:00:00Z" },
  { id: "archived", assistantId: "a", archivedAt: "2026-10-02T00:00:00Z" },
  { id: "telegram", assistantId: "a", channel: "telegram" },
  { id: "user", assistantId: "a", userId: "u-1", lastActivityAt: "2026-10-28T00:00:00Z" },
  { id: "other", assistantId: "b" },
];

test("an agent opens the chats the sidebar lists, main chat first", () => {
  assert.deepEqual(
    agentChats({ id: "a" }, chats).map((chat) => chat.id),
    ["main", "recent", "old"],
  );
});

test("a user's own agent also lists her chats", () => {
  assert.deepEqual(
    agentChats({ id: "a", userAccess: { mode: "own" } }, chats).map((chat) => chat.id),
    ["main", "user", "recent", "old"],
  );
  assert.deepEqual(agentChats({ id: "c" }, chats), []);
});
