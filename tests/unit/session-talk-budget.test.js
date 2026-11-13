import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TalkStore } from "../../server/features/assistants/session-talk/talk-store.js";
import {
  TALK_BUDGET,
  talkBudgetRefusal,
  noteLimit,
} from "../../server/features/assistants/session-talk/talk-budget.js";

const row = (at, extra = {}) => ({
  op: "tell",
  direction: "to-agent",
  assistantId: "a1",
  conversationId: "c1",
  sessionId: "s1",
  phase: "queued",
  createdAt: at,
  ...extra,
});
const open = () => new TalkStore(new DatabaseSync(":memory:"));
const pair = { sessionId: "s1", assistantId: "a1" };

test("the budget values", () => {
  assert.deepEqual(TALK_BUDGET, { pairPerMinute: 6, pairPerTenMinutes: 20 });
});

test("the 7th message within a minute is refused with a wait", () => {
  const store = open();
  const now = 1_000_000;
  for (let i = 0; i < 6; i++) store.create(row(now - 50_000 + i * 1000));
  const refusal = talkBudgetRefusal(store, { ...pair, now });
  assert.equal(refusal.limit, "minute");
  assert.ok(refusal.retryAfterSeconds >= 1);
  assert.equal(refusal.retryAfterSeconds, 10);
  assert.equal(
    talkBudgetRefusal(store, { sessionId: "s2", assistantId: "a1", now }),
    null,
  );
  assert.equal(
    talkBudgetRefusal(store, { sessionId: "s1", assistantId: "a2", now }),
    null,
  );
});

test("the 21st message within ten minutes is refused", () => {
  const store = open();
  const now = 10_000_000;
  for (let i = 0; i < 20; i++) store.create(row(now - 540_000 + i * 27_000));
  const refusal = talkBudgetRefusal(store, { ...pair, now });
  assert.equal(refusal.limit, "ten-minutes");
  assert.ok(refusal.retryAfterSeconds >= 1);
  assert.equal(talkBudgetRefusal(store, { ...pair, now: now + 700_000 }), null);
});

test("noteLimit records one row per pair and window", () => {
  const store = open();
  const first = noteLimit(store, row(0, { text: "limit" }));
  assert.equal(first.op, "limit");
  assert.equal(first.phase, "noted");
  assert.match(first.id, /^limit:s1:a1:\d+$/);
  assert.equal(noteLimit(store, row(0)), null);
  assert.equal(store.forConversation("c1").length, 1);
});
