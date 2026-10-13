import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

const quote = "ask the researcher what the budget is";
async function until(read, label = "condition") {
  for (let n = 0; n < 2000; n++) {
    const value = read();
    if (value) return value;
    await tick();
  }
  throw Error(`Timed out waiting for ${label}`);
}
// A lead whose team finished: its members can be asked; the second one is permanent.
async function lead(t) {
  const f = teamFixture(t);
  const { team, parent, chat, attempt } = await f.proposal({ count: 2 });
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId);
  await f.service.reconcile();
  const synthesis = f.service.store.get(team.id).resultAttemptId;
  if (synthesis) f.complete(synthesis);
  await f.service.reconcile();
  const [temporary, second] = f.service.store.members(team.id);
  const permanent = await f.service.lifecycle("promote", second.id, second.revision);
  const turn = (text = `Please ${quote}`, context = { kind: "owner" }) => {
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text,
    });
    f.service.store.recordContext(request.id, context);
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return { attemptId: attempt.id, toolCallId: crypto.randomUUID(), assertCurrent() {} };
  };
  // Ends every turn of the lead's chat, so a follow-up may be delivered.
  const idle = () => {
    for (const a of f.assistants.ledger.pending())
      if (f.assistants.ledger.getRequest(a.requestId).conversationId === chat.id)
        f.assistants.ledger.transition(a.id, "completed");
  };
  const requests = () => f.service.requests.store.list();
  const sends = () => f.calls.filter((c) => c.method === "sessions.send");
  return { ...f, team, parent, chat, temporary, permanent, turn, idle, requests, sends };
}
const ask = (f, member, inv, extra = {}) =>
  f.service.ask(inv, {
    memberId: member.id,
    question: "What is the budget?",
    ownerRequested: true,
    ownerRequestQuote: quote,
    ...extra,
  });

test("an answer within the wait returns as the ask tool's result", async (t) => {
  const f = await lead(t);
  const inv = f.turn();
  const pending = ask(f, f.temporary, inv);
  const r = await until(
    () => f.requests().find((x) => x.phase === "running"),
    "dispatch",
  );
  // The member gets only the question, framed as its lead's, in its own chat.
  const send = f.sends().at(-1).input;
  const memberChat = f.service.store.member(f.temporary.id).conversationId;
  assert.equal(send.key, f.store.getConversation(memberChat).runtimeSessionKey);
  assert.match(send.message, /^Question from "Parent", the lead agent/);
  assert.ok(send.message.endsWith("\n\nWhat is the budget?"));
  assert.ok(!send.message.includes(quote), "the lead's conversation stays private");
  f.complete(r.attemptId);
  await f.service.reconcile();
  const result = await pending;
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Result from member");
  assert.equal(f.service.requests.store.get(r.id).delivery, "inline");
  // No follow-up turn repeats an answer the lead already has.
  f.assistants.ledger.transition(inv.attemptId, "completed");
  await f.service.reconcile();
  assert.ok(
    !f.assistants.ledger
      .requests(f.chat.id)
      .some((x) => x.clientRequestId.startsWith("lead-request-result:")),
  );
  // The member's chat shows the bare question, marked as coming from the lead.
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) =>
    method === "chat.history" && input.sessionKey === send.key
      ? {
          messages: [
            {
              role: "user",
              content: send.message,
              timestamp: 5,
              idempotencyKey: `${r.attemptId}:user`,
              __openclaw: { id: "q1" },
            },
          ],
        }
      : call(method, input);
  const history = await f.assistants.history(memberChat);
  assert.deepEqual(history.messages[0], {
    id: "q1",
    role: "user",
    text: "What is the budget?",
    timestamp: 5,
    runId: null,
    source: "lead",
    sender: { kind: "agent", name: "Parent" },
  });
  const request = history.requests.find(
    (x) => x.clientRequestId === `lead-request:${r.id}`,
  );
  assert.equal(request.source, "lead");
  assert.equal(request.text, "What is the budget?");
});

test("a slow answer reaches the lead later as a hidden follow-up turn", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  const inv = f.turn();
  const result = await ask(f, f.temporary, inv);
  assert.equal(result.status, "asked");
  const r = f.requests()[0];
  f.complete(r.attemptId);
  await f.service.reconcile();
  // The lead's own turn is still running: nothing is injected into it.
  assert.equal(f.service.requests.store.get(r.id).phase, "completed");
  assert.equal(f.service.requests.store.get(r.id).delivery, null);
  f.assistants.ledger.transition(inv.attemptId, "completed");
  await f.service.reconcile();
  const followUp = f.assistants.ledger
    .requests(f.chat.id)
    .find((x) => x.clientRequestId === `lead-request-result:${r.id}`);
  assert.ok(followUp.text.includes("Result from member"));
  assert.ok(followUp.text.includes("not a new owner instruction"));
  assert.equal(f.service.store.context(followUp.id).kind, "member-result");
  const stored = f.service.requests.store.get(r.id);
  assert.equal(stored.delivery, "sent");
  // Replays adopt the follow-up instead of sending it again.
  await f.service.reconcile();
  assert.equal(f.sends().filter((s) => s.input.message === followUp.text).length, 1);
  const history = await f.assistants.history(f.chat.id);
  const visible = history.requests.find((x) => x.id === followUp.id);
  assert.equal(visible.internal, "member-result");
  assert.equal(visible.text, undefined);
});

test("a busy member gets the question only after its current turn ends", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  const memberChat = f.service.store.member(f.permanent.id).conversationId;
  const owner = await f.assistants.send(memberChat, {
    clientRequestId: "owner-chat",
    text: "Owner is chatting",
  });
  const before = f.sends().length;
  const result = await ask(f, f.permanent, f.turn());
  assert.equal(result.status, "asked");
  await f.service.reconcile();
  assert.equal(f.requests()[0].phase, "queued");
  assert.equal(f.sends().length, before, "never injected into the owner's turn");
  f.complete(owner.attempt.id);
  await f.service.reconcile();
  assert.equal(f.requests()[0].phase, "running");
  assert.equal(f.sends().length, before + 1);
});

test("a delegated task runs in the member's chat, can be cancelled and reports back", async (t) => {
  const f = await lead(t);
  const delegate = (inv) =>
    f.service.delegate(inv, {
      memberId: f.permanent.id,
      task: "Draft the budget",
      ownerRequested: true,
      ownerRequestQuote: quote,
    });
  const lead1 = f.turn();
  const first = await delegate(lead1);
  assert.equal(first.status, "delegated");
  const r = f.service.requests.store.get(first.requestId);
  assert.equal(r.phase, "running");
  assert.match(f.sends().at(-1).input.message, /^Task from "Parent"/);
  // A second task waits for the first to end; a temporary member takes none.
  await assert.rejects(delegate(f.turn()), { status: 409 });
  await assert.rejects(
    f.service.delegate(f.turn(), { memberId: f.temporary.id, task: "Draft" }),
    { status: 409 },
  );
  // The lead cancels: the member's turn is aborted and nothing is reported back.
  const cancelled = await f.service.cancel(lead1, { requestId: r.id });
  assert.equal(cancelled.requestId, r.id);
  assert.ok(f.calls.some((c) => c.method === "sessions.abort"));
  f.complete(r.attemptId, "error");
  f.assistants.ledger.transition(lead1.attemptId, "completed");
  await f.service.reconcile();
  const ended = f.service.requests.store.get(r.id);
  assert.equal(ended.phase, "cancelled");
  assert.equal(ended.delivery, "skipped");
  // The next task completes and its result reaches the lead as a summary turn.
  const lead2 = f.turn();
  const second = await delegate(lead2);
  const running = f.service.requests.store.get(second.requestId);
  f.complete(running.attemptId);
  f.idle();
  await f.service.reconcile();
  const followUp = f.assistants.ledger
    .requests(f.chat.id)
    .find((x) => x.clientRequestId === `lead-request-result:${running.id}`);
  assert.match(followUp.text, /as a short summary/);
  assert.match(followUp.text, /"result":"Result from member"/);
});

test("pending requests survive a restart without a second execution", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  await ask(f, f.temporary, f.turn());
  const running = f.requests()[0];
  // A claim whose send outcome is unknown when the process stops.
  const inv = f.turn();
  await f.service.delegate(inv, {
    memberId: f.permanent.id,
    task: "Draft",
    ownerRequested: true,
    ownerRequestQuote: quote,
  });
  const task = f.requests()[1];
  f.service.store.write(f.service.store.get(task.id), { phase: "dispatching" });
  const sendsBefore = f.sends().length;
  await f.service.close();
  const restarted = new TeamService({ assistants: f.assistants, autoStart: false });
  f.assistants.teams = restarted;
  t.after(() => restarted.close());
  assert.equal(restarted.requests.store.get(task.id).phase, "queued");
  await restarted.reconcile();
  // Adopted by its stable client id: the member got the task once.
  assert.equal(restarted.requests.store.get(task.id).phase, "running");
  assert.equal(f.sends().length, sendsBefore);
  // The question that was running keeps going and is delivered after the restart.
  f.complete(running.attemptId);
  f.idle();
  await restarted.reconcile();
  assert.equal(restarted.requests.store.get(running.id).delivery, "sent");
  // A member turn whose outcome stays unknown ends failed once reviewed, and the
  // lead learns that instead of waiting forever.
  const taskAttempt = restarted.requests.store.get(task.id).attemptId;
  f.assistants.ledger.transition(taskAttempt, "uncertain");
  await restarted.reconcile();
  assert.equal(restarted.requests.store.get(task.id).phase, "uncertain");
  f.assistants.ledger.review(taskAttempt);
  await restarted.reconcile();
  const failed = restarted.requests.store.get(task.id);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.diagnostic, "OUTCOME_REVIEWED");
});

test("agent-initiated requests wait for the owner's approval in the lead's chat", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  const result = await ask(
    f,
    f.temporary,
    f.turn("Summarize the team results", { kind: "team-result" }),
  );
  assert.equal(result.status, "awaiting_approval");
  const [r] = f.requests();
  assert.equal(f.assistants.list().activity[f.parent.id].pendingApprovals, 1);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(r.id).phase, "awaiting_approval");
  const approved = f.service.decideRequest(
    r.id,
    { revision: r.revision, decision: "approve" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(approved.phase, "queued");
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(r.id).phase, "running");
  assert.equal(f.assistants.list().activity[f.parent.id].pendingApprovals, 0);
});

test("the lead archives its finished temporary members, nothing else", async (t) => {
  const f = await lead(t);
  await assert.rejects(f.service.archive(f.turn(), { memberIds: [f.permanent.id] }), {
    status: 409,
  });
  const done = await f.service.archive(f.turn(), { memberIds: [f.temporary.id] });
  assert.deepEqual(done.archived, [f.temporary.id]);
  assert.ok(f.store.getAssistant(f.temporary.assistantId).archivedAt);
  // Archived members can no longer be asked or listed.
  await assert.rejects(ask(f, f.temporary, f.turn()), { status: 404 });
  const listed = f.service.members(f.turn(), {});
  assert.deepEqual(
    listed.members.map((m) => [m.memberId, m.lifetime]),
    [[f.permanent.id, "permanent"]],
  );
});

test("the bridge refuses the new lead tools to members", async (t) => {
  const f = await lead(t);
  const memberChat = f.store.getConversation(
    f.service.store.member(f.permanent.id).conversationId,
  );
  const member = f.store.getAssistant(f.permanent.assistantId);
  await f.assistants.send(memberChat.id, { clientRequestId: "m", text: "Hello" });
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  for (const action of ["members", "ask", "delegate", "cancel", "archive"])
    assert.throws(
      () =>
        bridge.prepare({
          agentId: member.runtimeAgentId,
          sessionKey: memberChat.runtimeSessionKey,
          toolCallId: `call-${action}`,
          action,
        }),
      { status: 403 },
      action,
    );
});
