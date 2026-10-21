import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  chatTitle,
  ownerChatFilter,
} from "../../web/features/assistants/chats/chat-names.js";
import { AgentHistoryCache } from "../../web/features/assistants/agent-offline.js";

test("a chat is called by its title, else as the main or a new chat", () => {
  setLanguage("en");
  assert.equal(chatTitle({ title: "Trip", main: true }), "Trip");
  assert.equal(chatTitle({ title: null, main: true }), "Main chat");
  assert.equal(chatTitle({ title: "", main: false }), "New chat");
  setLanguage("de");
  assert.equal(chatTitle({ main: true }), "Hauptchat");
});

test("the owner's list keeps his chats on shared agents and all of a user's own agent", () => {
  const chats = [{ id: "his" }, { id: "hers", userId: "u1" }];
  const shared = ownerChatFilter({ userAccess: { mode: "shared" } });
  assert.deepEqual(
    chats.filter(shared).map((c) => c.id),
    ["his"],
  );
  assert.deepEqual(
    chats.filter(ownerChatFilter({})).map((c) => c.id),
    ["his"],
  );
  assert.equal(ownerChatFilter({ userAccess: { mode: "own" } }), null);
});

test("an archived or deleted chat leaves the offline cache, the others stay", () => {
  const cache = new AgentHistoryCache();
  cache.set("a", { messages: [{ id: "1", text: "x" }] });
  cache.set("b", { messages: [{ id: "2", text: "y" }] });
  cache.drop("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b").messages[0].id, "2");
});
