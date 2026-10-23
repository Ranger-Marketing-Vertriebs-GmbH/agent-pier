import test from "node:test";
import assert from "node:assert/strict";
import { peers } from "../helpers/peer-request-fixture.js";
import { until } from "../helpers/lead-request-service-fixture.js";

const notesOf = (history) => history.messages.filter((m) => m.event === "peer-request");
const chatOf = (f, member) => f.service.store.member(member.id).conversationId;
// The lead's chat serves these turns; every other chat reads as before.
function leadTurns(f, messages) {
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) =>
    method === "chat.history" && input.sessionKey === f.chat.runtimeSessionKey
      ? { messages }
      : call(method, input);
}

test("the lead's chat shows one note when a peer request starts and one when it ends", async (t) => {
  const f = await peers(t);
  const sender = f.store.getAssistant(f.permanent.assistantId);
  f.store.updateAssistant(sender.id, { name: "Learning" }, sender.revision);
  const other = f.store.saveConversation({
    assistantId: f.parent.id,
    runtimeSessionKey: "parent-other",
  });
  const now = Date.now();
  leadTurns(f, [
    { role: "user", content: "Before", timestamp: now - 120000, __openclaw: { id: "b" } },
    { role: "user", content: "During", timestamp: now - 30000, __openclaw: { id: "d" } },
  ]);
  const turns = f.assistants.ledger.requests(f.chat.id).length;
  const r = f.peerAsk(f.memberTurn(f.permanent), f.second, {}, now - 60000);
  const started = notesOf(await f.assistants.history(f.chat.id));
  assert.deepEqual(started, [
    {
      id: `peer-start:${r.id}`,
      role: "event",
      event: "peer-request",
      phase: "started",
      type: "question",
      from: "Learning",
      to: "Member 2",
      timestamp: now - 60000,
      runId: null,
    },
  ]);
  await f.service.reconcile();
  const running = await until(
    () => f.requests().find((x) => x.id === r.id && x.phase === "running"),
    "dispatch",
  );
  f.complete(running.attemptId);
  await f.service.reconcile();
  const done = f.service.requests.store.get(r.id);
  assert.equal(done.phase, "completed");
  const history = await f.assistants.history(f.chat.id);
  assert.deepEqual(
    history.messages.map((m) => m.id),
    ["b", `peer-start:${r.id}`, "d", `peer-end:${r.id}`],
  );
  const end = notesOf(history)[1];
  assert.equal(end.phase, "completed");
  assert.equal(end.timestamp, Date.parse(done.finishedAt));
  // A note carries neither the question nor the answer.
  assert.ok(!JSON.stringify(notesOf(history)).includes("What did you find?"));
  assert.ok(!JSON.stringify(notesOf(history)).includes("Result from member"));
  // No lead turn, and no note in another chat of the lead or the members' chats.
  assert.equal(f.assistants.ledger.requests(f.chat.id).length, turns);
  assert.deepEqual(notesOf(await f.assistants.history(other.id)), []);
  for (const m of [f.permanent, f.second])
    assert.deepEqual(notesOf(await f.assistants.history(chatOf(f, m))), []);
});

test("a pruned peer request leaves no note and no error", async (t) => {
  const f = await peers(t);
  const r = f.peerDelegate(f.memberTurn(f.permanent), f.second);
  assert.equal(notesOf(await f.assistants.history(f.chat.id)).length, 1);
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  f.service.store.write(f.service.requests.store.get(r.id), {
    phase: "failed",
    settled: true,
    createdAt: old,
    finishedAt: old,
  });
  assert.equal(notesOf(await f.assistants.history(f.chat.id)).length, 2);
  assert.equal(f.service.requests.store.prune(), 1);
  const history = await f.assistants.history(f.chat.id);
  assert.deepEqual(notesOf(history), []);
  assert.ok(!f.service.requests.list().some((x) => x.id === r.id));
  assert.throws(() => f.service.requestDetail(r.id), { status: 404 });
});
