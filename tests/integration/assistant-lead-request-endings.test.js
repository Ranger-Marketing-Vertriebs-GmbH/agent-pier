import test from "node:test";
import assert from "node:assert/strict";
import { ask, lead, quoteFor } from "../helpers/lead-request-service-fixture.js";
import { peers } from "../helpers/peer-request-fixture.js";
import {
  defaultTeamPolicy,
  taskRunTimeoutMinutes,
} from "../../server/features/assistants/team-policy.js";

// How a lead learns why its question or task ended without a result (AGENTPIER-284).
const minute = 60000;
const delegate = (f, inv = f.turn()) =>
  f.service.delegate(inv, {
    memberId: f.permanent.id,
    task: "Coordinate the plan with your colleagues",
    ownerRequested: true,
    ownerRequestQuote: quoteFor(f.permanent),
  });
const startedAgo = (f, id, minutes) =>
  f.service.store.write(f.service.requests.store.get(id), {
    startedAt: new Date(Date.now() - minutes * minute).toISOString(),
  });
// The member's chat history serves `text` as the run's reply, also once it ended.
const wrote = (f, r, text) =>
  f.runs.set(r.attemptId, { ...f.runs.get(r.attemptId), status: "ok", replies: [text] });
// The lead's follow-up for a request, once its turns ended.
async function delivered(f, id) {
  f.idle();
  await f.service.reconcile();
  const turn = f.assistants.ledger
    .requests(f.chat.id)
    .find((x) => x.clientRequestId === `lead-request-result:${id}`);
  assert.ok(turn, "the lead gets a follow-up");
  return {
    turn,
    data: JSON.parse(turn.text.slice(turn.text.indexOf("\n{") + 1)),
    outcome: (await f.assistants.history(f.chat.id)).requests.find(
      (x) => x.id === turn.id,
    )?.internalOutcome,
  };
}

test("a lead's task runs up to 60 minutes; its questions keep the member time limit", async (t) => {
  const f = await lead(t);
  assert.equal(taskRunTimeoutMinutes, 60);
  assert.equal(defaultTeamPolicy.runTimeoutMinutes, 10);
  f.service.requests.waitMs = 0;
  await ask(f, f.temporary, f.turn());
  const question = f.requests().find((r) => r.type === "question");
  assert.equal(question.runTimeoutMinutes, 10);
  const task = f.service.requests.store.get((await delegate(f)).requestId);
  assert.equal(task.runTimeoutMinutes, 60);
  // 59 minutes in, the task still runs; the question is past its own limit.
  startedAgo(f, task.id, 59);
  startedAgo(f, question.id, 11);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).cancelRequested, undefined);
  assert.equal(f.service.requests.store.get(question.id).cancelledBy, "deadline");
  startedAgo(f, task.id, 61);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).cancelledBy, "deadline");
});

test("a deadline cancel tells the lead the reason, the minutes and the member's last reply", async (t) => {
  const f = await lead(t);
  const task = f.service.requests.store.get((await delegate(f)).requestId);
  startedAgo(f, task.id, 61);
  await f.service.reconcile();
  assert.ok(f.calls.some((c) => c.method === "sessions.abort"));
  // The member had written its consolidated draft when the run was aborted.
  f.runs.set(task.attemptId, {
    ...f.runs.get(task.attemptId),
    status: "ok",
    replies: ["Consolidated draft: Content, Automation and Network agree on A."],
  });
  f.assistants.ledger.transition(task.attemptId, "cancelled");
  await f.service.reconcile();
  const ended = f.service.requests.store.get(task.id);
  assert.equal(ended.phase, "cancelled");
  assert.equal(ended.diagnostic, "DEADLINE");
  assert.equal(ended.partial, true);
  // Questions and tasks label it a partial result, not the member's result.
  assert.equal(f.service.requests.list(f.parent.id).at(-1).partial, true);
  const { turn, data, outcome } = await delivered(f, task.id);
  assert.equal(data.phase, "cancelled");
  assert.equal(data.diagnostic, "DEADLINE");
  assert.equal(data.timeLimitMinutes, 60);
  assert.match(data.reason, /time limit of 60 minutes/);
  assert.equal(
    data.partialResult,
    "Consolidated draft: Content, Automation and Network agree on A.",
  );
  assert.equal(data.result, undefined, "never presented as a finished result");
  assert.match(turn.text, /report from the member may still follow/);
  assert.match(turn.text, /whole work so far is in the member's own chat/);
  assert.match(turn.text, /Tell the owner why it ended/);
  assert.doesNotMatch(turn.text, /\b(her|his|she|he)\b/i, "gender-neutral owner");
  assert.equal(outcome, "deadline");
});

test("a deadline cancel without any reply still names the reason", async (t) => {
  const f = await lead(t);
  const task = f.service.requests.store.get((await delegate(f)).requestId);
  startedAgo(f, task.id, 61);
  await f.service.reconcile();
  f.complete(task.attemptId, "error");
  await f.service.reconcile();
  const { data } = await delivered(f, task.id);
  assert.equal(data.diagnostic, "DEADLINE");
  assert.equal(data.partialResult, undefined);
});

test("an owner's cancel reaches the lead as cancelled by the owner", async (t) => {
  const f = await lead(t);
  const task = f.service.requests.store.get((await delegate(f)).requestId);
  await f.service.cancelRequest(task.id);
  // The member had written something; the owner's cancel does not pass it on.
  wrote(f, task, "Half a draft");
  f.assistants.ledger.transition(task.attemptId, "cancelled");
  await f.service.reconcile();
  const { data, outcome } = await delivered(f, task.id);
  assert.equal(data.phase, "cancelled");
  assert.equal(data.diagnostic, "OWNER_CANCELLED");
  assert.match(data.reason, /owner cancelled/);
  assert.equal(data.partialResult, undefined, "an owner's cancel keeps no reply");
  assert.equal(outcome, "owner");
});

test("a queued request the owner cancels names the owner too", async (t) => {
  const f = await lead(t);
  // The member is busy with an owner turn, so the question waits.
  const memberChat = f.service.store.member(f.permanent.id).conversationId;
  await f.assistants.send(memberChat, { clientRequestId: "owner-chat", text: "Hi" });
  f.service.requests.waitMs = 0;
  await ask(f, f.permanent, f.turn());
  const r = f.requests()[0];
  assert.equal(r.phase, "queued");
  await f.service.cancelRequest(r.id);
  assert.equal(f.service.requests.store.get(r.id).diagnostic, "OWNER_CANCELLED");
});

test("a member run stopped or failed on its own says so", async (t) => {
  for (const [state, diagnostic, phase, outcome] of [
    ["cancelled", "MEMBER_STOPPED", "cancelled", "stopped"],
    ["failed", "RUN_FAILED", "failed", "failed"],
  ]) {
    const f = await lead(t);
    const task = f.service.requests.store.get((await delegate(f)).requestId);
    // What the member wrote before its run ended goes along as a partial result.
    wrote(f, task, `Draft before the run ${state}`);
    f.assistants.ledger.transition(task.attemptId, state);
    await f.service.reconcile();
    assert.equal(f.service.requests.store.get(task.id).partial, true);
    const { turn, data, ...rest } = await delivered(f, task.id);
    assert.equal(data.phase, phase);
    assert.equal(data.diagnostic, diagnostic);
    assert.equal(typeof data.reason, "string");
    assert.equal(data.partialResult, `Draft before the run ${state}`);
    assert.equal(data.result, undefined);
    assert.match(turn.text, /partialResult is the member's last reply before it ended/);
    assert.match(turn.text, /whole work so far is in the member's own chat/);
    assert.doesNotMatch(turn.text, /report from the member may still follow/);
    assert.equal(rest.outcome, outcome);
  }
});

test("a task stored with a 10-minute deadline still ends after 10 minutes", async (t) => {
  const f = await lead(t);
  const task = f.service.requests.store.get((await delegate(f)).requestId);
  // As a task created before tasks got 60 minutes: its stored deadline holds.
  f.service.store.write(task, { runTimeoutMinutes: 10 });
  startedAgo(f, task.id, 9);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).cancelRequested, undefined);
  startedAgo(f, task.id, 11);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).cancelledBy, "deadline");
  f.complete(task.attemptId, "error");
  await f.service.reconcile();
  const { data } = await delivered(f, task.id);
  assert.equal(data.timeLimitMinutes, 10);
  assert.match(data.reason, /time limit of 10 minutes/);
});

test("a completed result keeps the plain member-result turn", async (t) => {
  const f = await lead(t);
  const task = f.service.requests.store.get((await delegate(f)).requestId);
  f.complete(task.attemptId);
  await f.service.reconcile();
  const { data, outcome } = await delivered(f, task.id);
  assert.equal(data.result, "Result from member");
  assert.equal(data.reason, undefined);
  assert.equal(outcome, undefined);
});

// Members' tasks for each other are team work too; their questions stay short.
test("a member's task for a colleague runs 60 minutes and its cancel is named", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  const asker = f.memberTurn(f.permanent);
  const question = f.peerAsk(asker, f.second);
  assert.equal(question.runTimeoutMinutes, 10);
  f.finish(question);
  const task = f.peerDelegate(f.memberTurn(f.permanent), f.second);
  assert.equal(task.runTimeoutMinutes, taskRunTimeoutMinutes);
  f.settle();
  await f.service.reconcile();
  const running = f.service.requests.store.get(task.id);
  assert.equal(running.phase, "running");
  startedAgo(f, task.id, 59);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).cancelRequested, undefined);
  startedAgo(f, task.id, 61);
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).cancelledBy, "deadline");
  f.complete(running.attemptId, "error");
  await f.service.reconcile();
  f.settle();
  await f.service.reconcile();
  // The asking member's chat names the cancel, not "a colleague's answer arrived".
  const chat = f.service.store.member(f.permanent.id).conversationId;
  const turn = f.assistants.ledger
    .requests(chat)
    .find((x) => x.clientRequestId === `peer-request-result:${task.id}`);
  assert.ok(turn, "the asker gets a follow-up");
  assert.equal(f.service.store.context(turn.id).outcome, "deadline");
  assert.match(turn.text, /"diagnostic":"DEADLINE"/);
  assert.match(turn.text, /Tell your lead why it ended/);
  const visible = (await f.assistants.history(chat)).requests.find(
    (x) => x.id === turn.id,
  );
  assert.equal(visible.internal, "peer-result");
  assert.equal(visible.internalOutcome, "deadline");
});
