import test from "node:test";
import assert from "node:assert/strict";
import {
  requestSource,
  requestsWithSources,
  turnKey,
  withMessageSources,
} from "../../server/features/assistants/message-source.js";

const at = (ms) => new Date(ms).toISOString();
const telegram = {
  kind: "telegram",
  channelId: "channel-1",
  chatId: "424242",
  userId: "424242",
  inputId: "input-1",
  forwarded: false,
  teamAllowed: false,
};
const owner = { kind: "owner", teamAllowed: false };
function fixture(...rows) {
  const contexts = new Map(),
    attempts = new Map();
  const requests = rows.map(([id, text, ms, context, attempt]) => {
    contexts.set(id, context);
    if (attempt) attempts.set(attempt, id);
    return { id, clientRequestId: `client-${id}`, text, createdAt: at(ms) };
  });
  return { requests, sources: { attempts, contexts } };
}
const user = (id, text, timestamp, key) => ({
  id,
  role: "user",
  text,
  timestamp,
  runId: null,
  ...(key && { turnKey: key }),
});
const mark = (messages, { requests, sources }) =>
  withMessageSources(messages, requests, sources);

test("OpenClaw's delivery key names the attempt that sent a turn", () => {
  assert.equal(turnKey({ idempotencyKey: "attempt-1:user" }), "attempt-1");
  assert.equal(
    turnKey({ __openclaw: { idempotencyKey: "attempt-1:user" } }),
    "attempt-1",
  );
  for (const message of [
    {},
    null,
    { idempotencyKey: 7 },
    { idempotencyKey: "attempt-1" },
    { idempotencyKey: ":user" },
  ])
    assert.equal(turnKey(message), null);
});

test("a keyed Telegram turn is the owner's, whatever its text and time", () => {
  const f = fixture(["r1", "Plan dinner", 1000, telegram, "attempt-1"]);
  const [marked] = mark([user("m1", "Plan dinner (edited)", 0, "attempt-1")], f);
  assert.deepEqual(marked, {
    ...user("m1", "Plan dinner (edited)", 0),
    source: "telegram",
    sender: { kind: "owner" },
  });
  assert.equal("turnKey" in marked, false);
});

test("a keyed turn of no known attempt is never matched by its text", () => {
  const f = fixture(["r1", "ok", 1000, telegram, "attempt-1"]);
  const [message] = mark([user("m1", "ok", 1100, "cron-run")], f);
  assert.deepEqual(message, user("m1", "ok", 1100));
});

test("an unkeyed turn needs the newest earlier request's exact text", () => {
  const f = fixture(["r1", "Plan dinner\r\nfor two  \n", 1000, telegram]);
  const [marked, other] = mark(
    [
      user("m1", "Plan dinner\nfor two", 1050),
      user("m2", "x Plan dinner\nfor two", 1060),
    ],
    f,
  );
  assert.equal(marked.source, "telegram");
  assert.equal(other.source, undefined);
  // A prefixed or suffixed text is a different turn.
  const short = fixture(["r1", "ok", 1000, telegram]);
  assert.equal(mark([user("m1", "that's ok", 1100)], short)[0].source, undefined);
});

test("web messages, replies and internal turns stay unmarked", () => {
  const f = fixture(
    ["r1", "From the web", 1000, owner, "attempt-1"],
    ["r2", "Team result", 5000, { kind: "unknown" }, "attempt-2"],
  );
  const messages = [
    user("m1", "From the web", 1100, "attempt-1"),
    { id: "a1", role: "assistant", text: "From the web", timestamp: 1200 },
    user("m2", "Team result", 5100),
  ];
  assert.deepEqual(mark(messages, f), [
    user("m1", "From the web", 1100),
    messages[1],
    messages[2],
  ]);
});

test("the same words sent from the web after Telegram belong to the web request", () => {
  const f = fixture(["r1", "ok", 1000, telegram], ["r2", "ok", 60000, owner]);
  const [first, second] = mark([user("m1", "ok", 1100), user("m2", "ok", 60100)], f);
  assert.equal(first.source, "telegram");
  assert.equal(second.source, undefined);
});

test("malformed metadata never marks a message", () => {
  const f = fixture(["r1", "Plan dinner", 10000, telegram]);
  f.requests.push(
    { id: "r2", text: "Bad date", createdAt: "not a date" },
    { id: "r3", text: null, createdAt: at(2000) },
  );
  f.sources.contexts.set("r2", telegram).set("r3", telegram);
  const messages = [
    user("m1", "Plan dinner", 0),
    user("m2", "Plan dinner", Number.NaN),
    { id: "m3", role: "user", text: { nested: true }, timestamp: 10100 },
    user("m4", "Bad date", 1500),
    // Written long before the request was accepted.
    user("m5", "Plan dinner", 5000),
  ];
  assert.deepEqual(mark(messages, f), messages);
  assert.equal(requestSource(undefined), null);
  assert.equal(requestSource("telegram"), null);
  assert.equal(requestSource({ kind: "Telegram" }), null);
});

test("no Telegram id, chat id or channel reaches the public projection", () => {
  const f = fixture(["r1", "Plan dinner", 1000, telegram, "attempt-1"]);
  const projected = JSON.stringify({
    messages: mark([user("m1", "Plan dinner", 1050, "attempt-1")], f),
    requests: requestsWithSources(f.requests, f.sources.contexts),
  });
  for (const secret of ["424242", "channel-1", "input-1", "chatId", "userId", "turnKey"])
    assert.ok(!projected.includes(secret), secret);
  assert.deepEqual(requestsWithSources(f.requests, f.sources.contexts)[0].sender, {
    kind: "owner",
  });
});
