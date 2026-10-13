import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { teamFixture } from "../helpers/assistant-team-fixture.js";

// The history a conversation serves marks the owner's Telegram turns from the
// trusted request context AgentPier recorded at send time. The transcript has the
// shape OpenClaw 2026.9.8 writes for `sessions.send` (assistant-channel-contract.js).
function conversation(t) {
  const f = teamFixture(t);
  const assistant = f.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "home-session",
  });
  const transcript = [];
  const client = f.assistants.runtime.client;
  const call = client.call.bind(client);
  client.call = async (method, input) => {
    if (method === "chat.history" && input.sessionKey === "home-session") {
      const end = transcript.length - (input.offset || 0);
      const start = Math.max(0, end - input.limit);
      return { messages: transcript.slice(start, end), hasMore: start > 0 };
    }
    const result = await call(method, input);
    if (method === "sessions.send" && input.key === "home-session") {
      const timestamp = Date.now();
      const key = `${input.idempotencyKey}:user`;
      transcript.push(
        {
          role: "user",
          content: input.message,
          timestamp,
          idempotencyKey: key,
          __openclaw: { id: randomUUID(), idempotencyKey: key, senderIsOwner: true },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `Reply to ${input.message}` }],
          timestamp: timestamp + 1,
          __openclaw: { id: randomUUID(), runId: input.idempotencyKey },
        },
      );
      f.runs.get(input.idempotencyKey).status = "ok";
    }
    return result;
  };
  const inputId = randomUUID();
  const telegram = {
    kind: "telegram",
    channelId: "channel-secret",
    chatId: "424242",
    userId: "424242",
    inputId,
    forwarded: false,
  };
  return { ...f, chat, client, inputId, telegram };
}
const marks = (history) =>
  history.messages.map((m) => [m.role, m.source || null, m.sender || null]);

test("history marks the owner's Telegram turns and never exposes Telegram ids", async (t) => {
  const f = conversation(t);
  await f.assistants.send(
    f.chat.id,
    { clientRequestId: `telegram:${f.inputId}`, text: "Plan dinner" },
    f.telegram,
  );
  const pending = await f.assistants.history(f.chat.id);
  assert.deepEqual(
    pending.requests.map((r) => [r.source, r.sender]),
    [["telegram", { kind: "owner" }]],
  );
  await f.assistants.reconcile();
  await f.assistants.send(f.chat.id, { clientRequestId: "web-1", text: "Plan dinner" });
  await f.assistants.reconcile();
  const history = await f.assistants.history(f.chat.id);
  // The same words from the web stay unmarked: the delivery key tells them apart.
  assert.deepEqual(marks(history), [
    ["user", "telegram", { kind: "owner" }],
    ["assistant", null, null],
    ["user", null, null],
    ["assistant", null, null],
  ]);
  const body = JSON.stringify(history);
  for (const secret of ["424242", "channel-secret", "chatId", "userId", "turnKey"])
    assert.ok(!body.includes(secret), secret);
  // The channel input id is AgentPier's own UUID, already public in clientRequestId;
  // it appears nowhere else.
  assert.equal(body.split(f.inputId).length - 1, 1);
});

test("earlier pages and the cached history keep the marks", async (t) => {
  const f = conversation(t);
  await f.assistants.send(
    f.chat.id,
    { clientRequestId: `telegram:${f.inputId}`, text: "From Telegram" },
    f.telegram,
  );
  await f.assistants.reconcile();
  for (const n of [1, 2]) {
    await f.assistants.send(f.chat.id, { clientRequestId: `web-${n}`, text: `Web ${n}` });
    await f.assistants.reconcile();
  }
  const latest = await f.assistants.history(f.chat.id, { limit: 4 });
  assert.equal(
    latest.messages.some((m) => m.source),
    false,
  );
  const earlier = await f.assistants.history(f.chat.id, {
    before: latest.nextBefore,
    limit: 4,
  });
  assert.deepEqual(marks(earlier), [
    ["user", "telegram", { kind: "owner" }],
    ["assistant", null, null],
  ]);
  // Gateway gone: the cached history is served and still marked.
  f.client.ready = false;
  const cached = await f.assistants.history(f.chat.id);
  assert.equal(cached.stale, true);
  assert.deepEqual(marks(cached)[0], ["user", "telegram", { kind: "owner" }]);
  assert.ok(!JSON.stringify(cached).includes("turnKey"));
});
