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
  const a = store.create(base);
  const b = store.create(base);
  store.create({ ...base, conversationId: "c2" });
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
  store.create({ ...base, op: "ask", late: true });
  store.create({ ...base, op: "limit" });
  store.create({ ...base, sessionId: "s2" });
  assert.deepEqual(store.pairCount({ sessionId: "s1", assistantId: "a1", since: 0 }), {
    count: 3,
    oldest: 1000,
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
