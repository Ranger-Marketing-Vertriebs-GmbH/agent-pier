import test from "node:test";
import assert from "node:assert/strict";
import {
  dreamChatBudget,
  dreamChats,
} from "../../server/features/assistants/hermes-dream-chats.js";
import { dreamInput } from "../../server/features/assistants/hermes-dream-prompt.js";

const day = Date.UTC(2026, 10, 8);
const at = (minutes) => day + minutes * 60000;
const iso = (minutes) => new Date(at(minutes)).toISOString();

// A history row as the port answers it: the runtime's fields and its `entry`.
const row = (role, text, minutes, extra = {}) => ({
  entry: {
    id: `${role}-${minutes}-${text.slice(0, 8)}`,
    role,
    text,
    timestamp: at(minutes),
    runId: null,
    turnKey: null,
    internal: false,
    compaction: null,
    ...extra,
  },
});

// Conversations of the store and a scripted sessions.history over `transcripts`
// (session key → rows, oldest first) that pages from the newest as the port does.
function fixture(conversations, transcripts) {
  const reads = [];
  const store = { listConversations: () => conversations };
  const sessions = {
    async history({ sessionKey, limit, offset = 0 }) {
      reads.push(sessionKey);
      const rows = transcripts[sessionKey] ?? [];
      const end = rows.length - offset;
      const start = Math.max(0, end - limit);
      return { messages: rows.slice(start, Math.max(0, end)), hasMore: start > 0 };
    },
  };
  return { store, sessions, reads };
}
const chat = (id, extra = {}) => ({
  id,
  assistantId: "agent",
  runtimeSessionKey: `key-${id}`,
  channel: "agentpier",
  lastActivityAt: iso(600),
  ...extra,
});

test("only the agent's undeleted chats active since the cursor are read", async () => {
  const f = fixture(
    [
      chat("a"),
      chat("other", { assistantId: "someone" }),
      chat("deleted", { deletedAt: iso(500) }),
      chat("quiet", { lastActivityAt: new Date(at(-3 * 1440)).toISOString() }),
      chat("unknown", { lastActivityAt: null }),
      chat("released", { userReleased: true }),
      chat("telegram", { channel: "telegram" }),
    ],
    {
      "key-a": [row("user", "Hello", 100)],
      "key-telegram": [row("user", "From the phone", 110)],
    },
  );
  const result = await dreamChats({
    ...f,
    assistantId: "agent",
    since: at(0),
    budget: 60000,
  });
  assert.deepEqual(f.reads.sort(), ["key-a", "key-telegram"]);
  assert.deepEqual(result, {
    chats: [
      {
        channel: "agentpier",
        messages: [{ role: "person", text: "Hello", at: at(100) }],
      },
      {
        channel: "telegram",
        messages: [{ role: "person", text: "From the phone", at: at(110) }],
      },
    ],
    until: at(110),
  });
});

test("internal turns, other roles and messages at or before the cursor are left out", async () => {
  const f = fixture([chat("a")], {
    "key-a": [
      row("user", "Old news", -10),
      row("assistant", "Exactly at the cursor", 0),
      row("user", "I like tea", 10),
      row("user", "Resume the cut turn", 11, { internal: true }),
      row("system", "System note", 12),
      row("tool", "Tool output", 13),
      row("assistant", "Noted: tea", 14),
      row("assistant", "", 15),
    ],
  });
  const { chats, until } = await dreamChats({
    ...f,
    assistantId: "agent",
    since: at(0),
    budget: 60000,
  });
  assert.deepEqual(chats, [
    {
      channel: "agentpier",
      messages: [
        { role: "person", text: "I like tea", at: at(10) },
        { role: "agent", text: "Noted: tea", at: at(14) },
      ],
    },
  ]);
  assert.equal(until, at(14));
});

test("chats beyond the budget are read the next night", async () => {
  const long = (c) => c.repeat(30000);
  const f = fixture([chat("a"), chat("b")], {
    "key-a": [row("user", long("a"), 10), row("user", long("c"), 30)],
    "key-b": [row("user", long("b"), 20)],
  });
  const first = await dreamChats({
    ...f,
    assistantId: "agent",
    since: at(0),
    budget: 3000,
  });
  // Each message is clipped to 2000 characters; the first two go in.
  assert.deepEqual(first, {
    chats: [
      {
        channel: "agentpier",
        messages: [{ role: "person", text: "a".repeat(2000), at: at(10) }],
      },
      {
        channel: "agentpier",
        messages: [{ role: "person", text: "b".repeat(2000), at: at(20) }],
      },
    ],
    until: at(20),
  });
  const next = await dreamChats({
    ...f,
    assistantId: "agent",
    since: first.until,
    budget: 3000,
  });
  assert.deepEqual(next, {
    chats: [
      {
        channel: "agentpier",
        messages: [{ role: "person", text: "c".repeat(2000), at: at(30) }],
      },
    ],
    until: at(30),
  });
  // Nothing new after that.
  assert.deepEqual(
    await dreamChats({ ...f, assistantId: "agent", since: next.until, budget: 3000 }),
    { chats: [], until: null },
  );
});

test("messages are sent oldest first, grouped by chat", async () => {
  // More rows than one page, so the read pages back to the cursor.
  const many = Array.from({ length: 450 }, (_, i) => row("user", `fact ${i}`, 100 + i));
  const f = fixture([chat("late"), chat("early")], {
    "key-late": [row("user", "Late one", 50), row("assistant", "Late two", 70)],
    "key-early": [
      row("user", "Early one", 40),
      row("assistant", "Early two", 60),
      ...many,
    ],
  });
  const { chats, until } = await dreamChats({
    ...f,
    assistantId: "agent",
    since: at(0),
    budget: 60000,
  });
  assert.equal(chats.length, 2);
  assert.deepEqual(chats[0].messages.slice(0, 2), [
    { role: "person", text: "Early one", at: at(40) },
    { role: "agent", text: "Early two", at: at(60) },
  ]);
  assert.equal(chats[0].messages.length, 452);
  assert.deepEqual(chats[0].messages.at(-1), {
    role: "person",
    text: "fact 449",
    at: at(549),
  });
  assert.deepEqual(chats[1].messages, [
    { role: "person", text: "Late one", at: at(50) },
    { role: "agent", text: "Late two", at: at(70) },
  ]);
  assert.equal(until, at(549));
});

test("every message chosen within the budget reaches the dream's input", async () => {
  // Astral characters: one code point, two UTF-16 units each.
  const text = (i) => `m${i}:${"😀".repeat(2000)}`;
  const rows = (from) =>
    Array.from({ length: 20 }, (_, i) => row("user", text(from + i), from + i));
  const f = fixture([chat("a"), chat("b")], { "key-a": rows(0), "key-b": rows(20) });
  const { chats, until } = await dreamChats({
    ...f,
    assistantId: "agent",
    since: -1,
    budget: dreamChatBudget,
  });
  const chosen = chats.flatMap((c) => c.messages);
  // 2000 code points each: 29 start below the 58000 of the budget.
  assert.equal(chosen.length, 29);
  assert.equal(until, at(28));
  const input = dreamInput({ files: {}, chats });
  for (const m of chosen)
    assert.ok(input.includes(`person: ${m.text}`), m.text.slice(0, 4));
});

test("the budget never cuts between messages of the same time", async () => {
  const f = fixture([chat("a"), chat("b")], {
    "key-a": [row("user", "x".repeat(2000), 10), row("user", "tie in a", 20)],
    "key-b": [row("user", "tie in b", 20), row("user", "later", 30)],
  });
  // The budget stops after "tie in a": its twin in b would be lost behind `until`.
  const first = await dreamChats({
    ...f,
    assistantId: "agent",
    since: at(0),
    budget: 2001,
  });
  assert.deepEqual(
    first.chats.flatMap((c) => c.messages.map((m) => m.text.slice(0, 8))),
    ["xxxxxxxx"],
  );
  assert.equal(first.until, at(10));
  const next = await dreamChats({
    ...f,
    assistantId: "agent",
    since: first.until,
    budget: 2001,
  });
  assert.deepEqual(
    next.chats.flatMap((c) => c.messages.map((m) => m.text)),
    ["tie in a", "tie in b", "later"],
  );
  // A first group of equal times larger than the budget goes in whole.
  const g = fixture([chat("a"), chat("b")], {
    "key-a": [row("user", "y".repeat(2000), 10)],
    "key-b": [row("user", "z".repeat(2000), 10), row("user", "after", 11)],
  });
  const whole = await dreamChats({
    ...g,
    assistantId: "agent",
    since: at(0),
    budget: 1000,
  });
  assert.equal(whole.chats.flatMap((c) => c.messages).length, 2);
  assert.equal(whole.until, at(10));
});
