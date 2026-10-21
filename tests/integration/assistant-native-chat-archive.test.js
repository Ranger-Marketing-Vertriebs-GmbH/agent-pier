import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";

// OpenClaw's maintenance (pruneAfter, maxEntries) can archive a chat's native session;
// the pinned runtime's answers are pinned in assistant-multi-chat-contract.test.js.
// Here the fake Gateway keeps each session's archived and pinned state like it.
// What gateway-client.js makes of OpenClaw 2026.10.3's refusal (dist/lifecycle-*.mjs).
const archivedRefusal = (key) =>
  Object.assign(Error("INVALID_REQUEST"), {
    code: "INVALID_REQUEST",
    answered: true,
    remoteMessage: `Session "${key}" is archived. Restore it before starting new work.`,
  });

function nativeChats(t) {
  const f = teamFixture(t);
  const agent = f.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const native = new Map();
  const chat = (key, state = {}, fields = {}) => {
    native.set(key, { sessionId: `id-${key}`, archived: false, pinned: false, ...state });
    const saved = f.store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: key,
    });
    if (Object.keys(fields).length) f.store.updateConversation(saved.id, fields);
    return f.store.getConversation(saved.id);
  };
  const client = f.assistants.runtime.client;
  const call = client.call.bind(client);
  const log = [];
  client.call = async (method, input) => {
    const session = native.get(input?.key);
    if (["sessions.describe", "sessions.patch", "sessions.send"].includes(method))
      log.push([method, input.key]);
    if (method === "sessions.describe") return { session: session ? { ...session } : {} };
    if (method === "sessions.patch") {
      assert.equal(input.expectedSessionId, session.sessionId);
      if ("archived" in input) session.archived = input.archived;
      if (input.pinned && session.archived)
        throw Object.assign(Error("cannot pin an archived session"), {
          code: "INVALID_REQUEST",
        });
      if ("pinned" in input) session.pinned = input.pinned;
      return { ok: true };
    }
    if (method === "sessions.send" && session?.archived) throw archivedRefusal(input.key);
    return call(method, input);
  };
  return { ...f, agent, native, chat, client, log };
}

test("a reconcile pass pins open chats and reopens natively archived ones once per connection", async (t) => {
  const f = nativeChats(t);
  f.chat("open");
  f.chat("pinned", { pinned: true });
  f.chat("pruned", { archived: true });
  // A chat in AgentPier's own archive is pinned too, so OpenClaw's entry cap and
  // disk budget cannot archive or delete it, but it takes no subscription. A
  // released user's chat is never touched.
  f.chat("kept-archived", { archived: true }, { archivedAt: new Date().toISOString() });
  f.chat("kept-open", {}, { archivedAt: new Date().toISOString() });
  f.chat("released", { archived: true }, { userReleased: true });
  await f.assistants.reconcile();
  assert.deepEqual(
    Object.fromEntries([...f.native].map(([key, s]) => [key, [s.archived, s.pinned]])),
    {
      open: [false, true],
      pinned: [false, true],
      pruned: [false, true],
      "kept-archived": [false, true],
      "kept-open": [false, true],
      released: [true, false],
    },
  );
  assert.deepEqual(
    f.log.filter(([method]) => method === "sessions.patch").map(([, key]) => key),
    ["open", "pruned", "kept-archived", "kept-open"],
  );
  assert.ok(!f.log.some(([, key]) => key === "released"));
  const subscribed = f.calls
    .filter((c) => c.method === "sessions.messages.subscribe")
    .map((c) => c.input.key);
  assert.ok(!subscribed.includes("kept-archived") && !subscribed.includes("kept-open"));
  // Further passes on the same connection ask no more.
  f.log.length = 0;
  await f.assistants.reconcile();
  assert.deepEqual(f.log, []);
  // A new connection (a Gateway restart may have archived it again) checks anew.
  f.native.get("pruned").archived = true;
  f.native.get("pruned").pinned = false;
  f.assistants.runtime.client = { ...f.client, call: f.client.call };
  await f.assistants.reconcile();
  assert.deepEqual(
    [f.native.get("pruned").archived, f.native.get("pruned").pinned],
    [false, true],
  );
});

test("a chat kept in AgentPier's archive is not reopened or pinned once deleted", async (t) => {
  const f = nativeChats(t);
  const chat = f.chat(
    "deleted",
    { archived: true },
    { archivedAt: new Date().toISOString() },
  );
  f.store.forgetConversation(chat.id, { deletedAt: new Date().toISOString() });
  await f.assistants.reconcile();
  assert.deepEqual(f.log, []);
  assert.equal(f.native.get("deleted").archived, true);
});

test("a failed keep is logged once and retried by the next pass", async (t) => {
  const f = nativeChats(t);
  f.chat("reset");
  const warn = t.mock.method(console, "warn", () => {});
  // A concurrent reset gives the session a new id between describe and patch.
  const call = f.client.call;
  let resets = 2;
  f.client.call = async (method, input) => {
    if (method === "sessions.patch" && resets-- > 0)
      throw Object.assign(Error("INVALID_REQUEST"), {
        code: "INVALID_REQUEST",
        answered: true,
        remoteMessage: `Session "${input.key}" changed while starting work. Retry.`,
      });
    return call(method, input);
  };
  await f.assistants.reconcile();
  assert.equal(f.native.get("reset").pinned, false);
  await f.assistants.reconcile({ full: false });
  assert.equal(f.native.get("reset").pinned, false);
  assert.equal(warn.mock.callCount(), 1);
  const [line] = warn.mock.calls[0].arguments;
  assert.match(line, /INVALID_REQUEST/);
  assert.doesNotMatch(line, /changed while starting work|reset/);
  await f.assistants.reconcile({ full: false });
  assert.equal(f.native.get("reset").pinned, true);
  assert.equal(
    f.log.filter(([method]) => method === "sessions.describe").length,
    3,
    "each pass tried again until the keep held",
  );
});

test("a turn refused for a natively archived session reopens it and goes through once", async (t) => {
  const f = nativeChats(t);
  const chat = f.chat("pruned", { archived: true });
  const { attempt } = await f.assistants.send(chat.id, {
    clientRequestId: "after-a-month",
    text: "Still there?",
  });
  assert.equal(attempt.state, "accepted");
  const sends = f.calls.filter((c) => c.method === "sessions.send");
  assert.equal(sends.length, 1, "the refused send never reached the fake's run log");
  assert.equal(sends[0].input.idempotencyKey, attempt.id);
  assert.deepEqual(
    f.log.map(([method]) => method),
    ["sessions.send", "sessions.describe", "sessions.patch", "sessions.send"],
  );
  assert.deepEqual(
    [f.native.get("pruned").archived, f.native.get("pruned").pinned],
    [false, true],
  );
});

test("another refusal is not retried and leaves the turn uncertain", async (t) => {
  const f = nativeChats(t);
  const chat = f.chat("open");
  const call = f.client.call;
  let sends = 0;
  f.client.call = async (method, input) => {
    if (method === "sessions.send") {
      sends++;
      throw Object.assign(Error("invalid"), { code: "INVALID_REQUEST", answered: true });
    }
    return call(method, input);
  };
  const { attempt } = await f.assistants.send(chat.id, {
    clientRequestId: "refused",
    text: "Hello",
  });
  assert.equal(attempt.state, "uncertain");
  // The open session is only pinned; the turn is not sent again.
  assert.equal(sends, 1);
  assert.equal(f.native.get("open").pinned, true);
});
