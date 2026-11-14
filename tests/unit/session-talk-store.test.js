import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TalkStore } from "../../server/features/assistants/session-talk/talk-store.js";

const base = {
  op: "ask",
  direction: "to-agent",
  assistantId: "a1",
  conversationId: "c1",
  sessionId: "s1",
  text: "hi",
  phase: "queued",
};
const open = (now = () => 1000) => new TalkStore(new DatabaseSync(":memory:"), now);

test("create, get and patch round trip", () => {
  const store = open();
  const row = store.create(base);
  assert.equal(row.createdAt, 1000);
  assert.deepEqual(store.get(row.id), row);
  const next = store.patch(row.id, { phase: "answered", answer: "ok" });
  assert.equal(next.phase, "answered");
  assert.equal(store.get(row.id).answer, "ok");
  assert.equal(store.get("none"), null);
});

test("pending holds open turns and unsettled late asks only", () => {
  const store = open();
  const queued = store.create(base);
  const running = store.create({ ...base, phase: "running" });
  store.create({ ...base, phase: "answered" });
  const late = store.create({ ...base, phase: "failed", late: true });
  store.create({ ...base, phase: "late-delivered", late: true });
  store.create({ ...base, op: "tell", direction: "to-session", phase: "sent" });
  store.create({ ...base, direction: "to-session", phase: "queued" });
  assert.deepEqual(
    store.pending().map((r) => r.id),
    [queued.id, running.id, late.id],
  );
});

test("forConversation lists oldest first", () => {
  let t = 5;
  const store = open(() => t++);
  const send = { ...base, op: "send", direction: "to-session" };
  const a = store.create(send);
  const b = store.create(send);
  store.create({ ...send, conversationId: "c2" });
  assert.deepEqual(
    store.forConversation("c1").map((r) => r.id),
    [a.id, b.id],
  );
});

test("pairCount counts both directions and ignores late and limit rows", () => {
  const store = open();
  store.create(base);
  store.create({ ...base, op: "send", direction: "to-session" });
  store.create({ ...base, op: "tell" });
  store.create({ ...base, op: "late", late: true });
  store.create({ ...base, op: "ask", late: true, phase: "failed" });
  store.create({ ...base, op: "limit" });
  store.create({ ...base, sessionId: "s2" });
  assert.deepEqual(store.pairCount({ sessionId: "s1", assistantId: "a1", since: 0 }), {
    count: 4,
    oldest: 1000,
    times: [1000, 1000, 1000, 1000],
  });
  assert.equal(
    store.pairCount({ sessionId: "s1", assistantId: "a1", since: 2000 }).count,
    0,
  );
});

test("prune drops rows older than 30 days and keeps 500 per agent", () => {
  let t = 0;
  const day = 86_400_000;
  const store = open(() => t);
  store.create({ ...base, createdAt: 0 });
  t = 40 * day;
  for (let i = 0; i < 502; i++) store.create({ ...base, createdAt: t - 1000 + i });
  const other = store.create({ ...base, assistantId: "a2", createdAt: t });
  store.prune();
  const left = store.db
    .prepare("SELECT assistant_id, count(*) n FROM session_talk GROUP BY 1")
    .all();
  assert.deepEqual(
    left.map((r) => [r.assistant_id, r.n]),
    [
      ["a1", 500],
      ["a2", 1],
    ],
  );
  assert.ok(store.get(other.id));
});

test("pending reads only the open rows and follows patches", () => {
  const store = open();
  const queued = store.create(base);
  const done = store.create({ ...base, phase: "answered" });
  assert.deepEqual(
    store.db
      .prepare("SELECT id FROM session_talk WHERE open=1")
      .all()
      .map((r) => r.id),
    [queued.id],
  );
  store.patch(queued.id, { phase: "answered" });
  assert.deepEqual(store.pending(), []);
  store.patch(done.id, { late: true });
  assert.deepEqual(
    store.pending().map((r) => r.id),
    [done.id],
  );
  store.patch(done.id, { phase: "late-delivered" });
  assert.deepEqual(store.pending(), []);
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT body FROM session_talk WHERE open=1 ORDER BY created_at, rowid",
    )
    .all()
    .map((r) => r.detail)
    .join(" ");
  assert.match(plan, /session_talk_open/);
});

test("unclaimedAsks skips inline, late and settled asks", () => {
  const store = open();
  const queued = store.create(base);
  const answered = store.create({ ...base, phase: "answered" });
  store.create({ ...base, phase: "answered", inline: true });
  store.create({ ...base, phase: "running", late: true });
  store.create({ ...base, phase: "late-delivered" });
  store.create({ ...base, op: "tell" });
  assert.deepEqual(
    store.unclaimedAsks().map((r) => r.id),
    [queued.id, answered.id],
  );
});

test("forConversation lists only the noted ops within the keep window", () => {
  let t = 0;
  const store = open(() => t);
  store.create({ ...base, op: "send", direction: "to-session", createdAt: 0 });
  t = 40 * 86_400_000;
  store.create(base);
  const send = store.create({ ...base, op: "send", direction: "to-session" });
  const late = store.create({ ...base, op: "late", direction: "to-session" });
  const limit = store.create({ ...base, op: "limit", phase: "noted" });
  assert.deepEqual(
    store.forConversation("c1").map((r) => r.id),
    [send.id, late.id, limit.id],
  );
});

test("an older table without the lookup columns is migrated from the bodies", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE session_talk (id TEXT PRIMARY KEY, assistant_id TEXT, session_id TEXT, conversation_id TEXT, created_at INTEGER, body TEXT)",
  );
  const insert = db.prepare("INSERT INTO session_talk VALUES (?,?,?,?,?,?)");
  const rows = [
    { ...base, id: "q", createdAt: 1 },
    { ...base, id: "a", phase: "answered", createdAt: 2 },
    { ...base, id: "l", phase: "failed", late: true, createdAt: 3 },
    {
      ...base,
      id: "s",
      op: "send",
      direction: "to-session",
      phase: "sent",
      createdAt: 4,
    },
    { ...base, id: "i", phase: "answered", inline: true, createdAt: 5 },
  ];
  for (const row of rows)
    insert.run(
      row.id,
      row.assistantId,
      row.sessionId,
      row.conversationId,
      row.createdAt,
      JSON.stringify(row),
    );
  const store = new TalkStore(db, () => 10);
  assert.deepEqual(
    store.pending().map((r) => r.id),
    ["q", "l"],
  );
  assert.deepEqual(
    store.unclaimedAsks().map((r) => r.id),
    ["q", "a"],
  );
  assert.equal(
    store.pairCount({ sessionId: "s1", assistantId: "a1", since: 0 }).count,
    5,
  );
  assert.deepEqual(
    store.forConversation("c1").map((r) => r.id),
    ["s"],
  );
  // Opening it again changes nothing.
  const again = new TalkStore(db, () => 10);
  assert.deepEqual(
    again.pending().map((r) => r.id),
    ["q", "l"],
  );
});
