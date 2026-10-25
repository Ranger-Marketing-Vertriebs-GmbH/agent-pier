import test from "node:test";
import assert from "node:assert/strict";
import { lead, until } from "../helpers/lead-request-service-fixture.js";
import { ownerChatQuietMs } from "../../server/features/assistants/member-summaries.js";

// A lead whose permanent member's task chat reports `tokens` of a 200,000-token
// window (OpenClaw 2026.10.3 `chat.history` sessionInfo), per session key.
async function longChat(t) {
  const f = await lead(t);
  const sizes = new Map();
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    const result = await call(method, input);
    if (method !== "chat.history" || !sizes.has(input.sessionKey)) return result;
    return {
      ...result,
      sessionInfo: {
        totalTokens: sizes.get(input.sessionKey),
        totalTokensFresh: true,
        contextTokens: 200000,
      },
    };
  };
  const member = f.service.store.member(f.permanent.id);
  const taskChat = f.store.getConversation(member.conversationId);
  const size = (tokens, chat = taskChat) => sizes.set(chat.runtimeSessionKey, tokens);
  const hints = () =>
    f.assistants.ledger
      .requests(f.chat.id)
      .filter((r) => r.clientRequestId.startsWith("member-long-chat:"));
  const long = f.service.memberLongChats;
  return { ...f, member, taskChat, size, hints, long };
}

test("a settled turn in a long task chat tells the lead once per size", async (t) => {
  const f = await longChat(t);
  f.size(130000);
  // A task turn in the member's chat ends as the Gateway reports it.
  const sent = await f.assistants.send(
    f.taskChat.id,
    { clientRequestId: "task-turn", text: "Go on" },
    { kind: "team-member" },
  );
  f.runs.set(sent.attempt.id, { ...f.runs.get(sent.attempt.id), status: "ok" });
  await f.assistants.reconcile();
  const [hint] = await until(() => f.hints().length && f.hints(), "the lead hint");
  assert.match(hint.text, /"Member 1"/);
  assert.match(hint.text, /130,000 tokens/);
  assert.match(hint.text, /65% of its context window/);
  assert.match(hint.text, /agentpier_team_member_summarise/);
  assert.match(hint.text, /"now"/);
  assert.match(hint.text, /"after_task"/);
  assert.ok(hint.text.includes(f.member.id));
  const context = f.service.store.context(hint.id);
  assert.equal(context.kind, "member-long-chat");
  assert.equal(context.memberId, f.member.id);
  assert.equal(f.long.told(f.taskChat.id), 130000);
  // The lead's chat shows a compact event, not AgentPier's text.
  const history = await f.assistants.history(f.chat.id);
  const visible = history.requests.find((r) => r.id === hint.id);
  assert.equal(visible.internal, "member-long-chat");
  assert.equal(visible.text, undefined);
  // Not again at the same size, nor before it grew by 50,000 tokens.
  f.idle();
  await f.long.check(f.taskChat.id);
  f.size(179999);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 1);
  f.size(180000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 2);
  assert.match(f.hints()[1].text, /180,000 tokens/);
  assert.equal(f.long.told(f.taskChat.id), 180000);
});

// AGENTPIER-248: the lead could not summarise a chat the owner talks in himself.
test("no hint while the owner talks with the member in its chat", async (t) => {
  const f = await longChat(t);
  f.size(130000);
  const sent = await f.assistants.send(f.taskChat.id, {
    clientRequestId: "owner-turn",
    text: "Go on",
  });
  f.runs.set(sent.attempt.id, { ...f.runs.get(sent.attempt.id), status: "ok" });
  await f.assistants.reconcile();
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 0);
  assert.equal(f.long.told(f.taskChat.id), null);
  // An hour after his last message the lead hears of the long chat.
  f.long.now = () => Date.now() + ownerChatQuietMs + 60_000;
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 1);
});

test("a smaller chat grows by half before the lead hears again", async (t) => {
  const f = await longChat(t);
  // No known window: long from 100,000 tokens; grown by half at 150,000.
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    const result = await call(method, input);
    return method === "chat.history" && result.sessionInfo
      ? { ...result, sessionInfo: { ...result.sessionInfo, contextTokens: undefined } }
      : result;
  };
  f.size(99999);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 0);
  assert.equal(f.long.told(f.taskChat.id), null);
  f.size(100000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 1);
  assert.doesNotMatch(f.hints()[0].text, /context window/);
  f.idle();
  f.size(149999);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 1);
  f.size(150000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 2);
});

test("a summary clears the marker, so the lead hears again once it is long", async (t) => {
  const f = await longChat(t);
  f.size(130000);
  await f.long.check(f.taskChat.id);
  f.idle();
  f.size(20000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.long.told(f.taskChat.id), null);
  assert.equal(f.hints().length, 1);
  f.size(125000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 2);
  // clear() forgets it too (the lead's summary tool).
  f.long.clear(f.taskChat.id);
  assert.equal(f.long.told(f.taskChat.id), null);
});

test("a stale token count tells nothing", async (t) => {
  const f = await longChat(t);
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    const result = await call(method, input);
    return method === "chat.history" && result.sessionInfo
      ? { ...result, sessionInfo: { ...result.sessionInfo, totalTokensFresh: false } }
      : result;
  };
  f.size(190000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 0);
});

test("the hint waits while the lead's chat has a turn, and retries a busy chat", async (t) => {
  const f = await longChat(t);
  const busy = f.turn();
  f.size(130000);
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 0, "never injected into the lead's own turn");
  assert.equal(f.long.told(f.taskChat.id), 130000);
  f.assistants.ledger.transition(busy.attemptId, "completed");
  // A busy answer is retried later with the same client id.
  const send = f.assistants.send.bind(f.assistants);
  let refusals = 1;
  f.assistants.send = (...args) =>
    refusals-- > 0
      ? Promise.reject(Object.assign(Error("busy"), { status: 409 }))
      : send(...args);
  await f.long.tick();
  assert.equal(f.hints().length, 0);
  f.long.now = () => Date.now() + 10 * 60000;
  await f.service.reconcile();
  assert.equal(f.hints().length, 1);
  await f.service.reconcile();
  assert.equal(f.hints().length, 1);
});

test("no hint for other chats, other agents, archived members or a pending summary", async (t) => {
  const f = await longChat(t);
  // A further chat the owner opened with the member is the owner's alone.
  const other = f.store.saveConversation({
    assistantId: f.member.assistantId,
    runtimeSessionKey: "member-new-chat",
  });
  f.size(190000, other);
  await f.long.check(other.id);
  // An agent that is no team member.
  const plain = f.store.createAssistant({
    name: "Plain",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const plainChat = f.store.saveConversation({
    assistantId: plain.id,
    runtimeSessionKey: "plain-chat",
  });
  f.size(190000, plainChat);
  await f.long.check(plainChat.id);
  // The lead's own chat is no member's task chat.
  f.size(190000, f.chat);
  await f.long.check(f.chat.id);
  assert.equal(f.hints().length, 0);
  // A summary of the member after its task is pending (MemberSummaries, Task 5).
  f.size(190000);
  f.long.summaryPending = (memberId) => memberId === f.member.id;
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 0);
  assert.equal(f.long.told(f.taskChat.id), null);
  f.long.summaryPending = () => false;
  // An archived member.
  const current = f.service.store.member(f.member.id);
  f.service.store.write(current, { archivedAt: new Date().toISOString() });
  await f.long.check(f.taskChat.id);
  assert.equal(f.hints().length, 0);
  assert.equal(f.long.told(f.taskChat.id), null);
});

test("one note that fails to deliver neither stops the others nor the team tick", async (t) => {
  const f = await longChat(t);
  const insert = f.long.db.prepare(
    "INSERT INTO assistant_member_long_chats VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const id of ["first", "second"])
    insert.run(id, f.member.id, 130000, 200000, "pending", 0, 0, "2026-10-23T10:00:00Z");
  const delivered = [];
  const deliver = f.long.deliver.bind(f.long);
  f.long.deliver = async (id) => {
    if (id === "first") throw Error("unreadable");
    delivered.push(id);
    return deliver(id);
  };
  const warn = t.mock.method(console, "warn", () => {});
  await f.long.tick();
  assert.deepEqual(delivered, ["second"]);
  assert.equal(warn.mock.callCount(), 1);
  // The team tick resolves; the failing note stays pending, logged once.
  await f.service.reconcile();
  assert.equal(f.long.row("first").delivery, "pending");
  assert.equal(warn.mock.callCount(), 1, "logged once");
});
