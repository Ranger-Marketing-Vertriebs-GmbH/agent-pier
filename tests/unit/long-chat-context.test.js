import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  longChatTokens,
  longContext,
} from "../../server/features/assistants/conversations.js";
import { LongChats, reappearsAt } from "../../server/features/assistants/long-chats.js";

// OpenClaw 2026.10.3 `chat.history` sessionInfo (assistant-run-steps-contract pins it).
test("a chat is long from 60 % of its window, or 100k tokens without one", () => {
  const info = (totalTokens, contextTokens, totalTokensFresh = true) => ({
    totalTokens,
    contextTokens,
    totalTokensFresh,
  });
  assert.equal(longContext(info(240000, 400000)), true);
  assert.equal(longContext(info(239999, 400000)), false);
  assert.equal(longContext(info(120000, 200000)), true);
  assert.equal(longContext(info(119999, 200000)), false);
  assert.equal(longContext(info(19700, 32768)), true);
  assert.equal(longContext(info(19600, 32768)), false);
  // Without a known window: a fixed size.
  assert.equal(longContext(info(longChatTokens, undefined)), true);
  assert.equal(longContext(info(99999, 0)), false);
  // A size that is not current (after a failed turn or a compaction) says nothing.
  assert.equal(longContext(info(150000, 400000, false)), false);
  assert.equal(longContext(undefined), false);
  assert.equal(longContext({ totalTokensFresh: true }), false);
});

// A hidden hint (long-chats.js) shows again after +50 % or +50k tokens, the earlier.
test("a hidden long-chat hint returns after half again or 50k more tokens", () => {
  assert.equal(reappearsAt(26000), 39000);
  assert.equal(reappearsAt(100000), 150000);
  assert.equal(reappearsAt(120000), 170000);
  assert.equal(reappearsAt(300000), 350000);
});

test("hidden hints are kept per person and chat, and go with a deleted chat", () => {
  const db = new DatabaseSync(":memory:");
  const chats = new LongChats({ store: { db } });
  const owners = { id: "c-1" };
  const hers = { id: "c-1", userId: "anna" };
  db.prepare("INSERT INTO assistant_long_chat_dismissals VALUES(?,?,?,?)").run(
    "c-1",
    "owner",
    120000,
    "2026-10-21T10:00:00.000Z",
  );
  assert.equal(chats.hidden(owners, 150000), true);
  assert.equal(chats.hidden(owners, 170000), false);
  assert.equal(chats.hidden(hers, 150000), false);
  chats.forget("c-1");
  assert.equal(chats.hidden(owners, 150000), false);
});
