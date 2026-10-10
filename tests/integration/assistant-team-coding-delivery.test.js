import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { deliverFollowUps } from "../../server/features/assistants/team-coding.js";

// A finished member run, delivered through the real AssistantService.send and
// TeamService.assertMemberTurn admission path.
async function setup(t) {
  const f = teamFixture(t),
    { team, parent, chat } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const member = f.service.store.members(team.id)[0];
  let now = 0;
  const w = {
    a: f.assistants,
    store: new AssistantActionStore(f.store.db),
    now: () => now,
  };
  const action = w.store.reserve({
    assistantId: parent.id,
    conversationId: chat.id,
    attemptId: member.attemptId,
    origin: { kind: "team-member", teamId: team.id, memberId: member.id },
    payload: { action: "coding_start", projectId: "p", pipelineId: "q", task: "Fix" },
    key: "delivery",
    state: "completed",
    requestedBy: member.id,
    teamId: team.id,
    memberName: member.name,
    memberConversationId: member.conversationId,
    runId: "run",
    run: { id: "run", status: "completed", url: "/pipelines/runs/run" },
  });
  const sends = () => f.calls.filter((c) => c.method === "sessions.send").length;
  return { ...f, w, member, action, sends, advance: (ms) => (now += ms) };
}

test("a busy member retries delivery and receives the result exactly once", async (t) => {
  const f = await setup(t);
  const before = f.sends();
  // The member's own turn is still pending in its conversation.
  assert.equal(await deliverFollowUps(f.w, f.action), false);
  let current = f.w.store.get(f.action.id);
  assert.equal(current.memberResultFailures, 1);
  assert.equal(await deliverFollowUps(f.w, current), false, "waits for its backoff");
  // The turn ended, but the member is still active until the scheduler observes it:
  // TeamService.assertMemberTurn refuses the turn.
  f.assistants.ledger.transition(f.member.attemptId, "completed");
  f.advance(10000);
  assert.equal(await deliverFollowUps(f.w, f.w.store.get(f.action.id)), false);
  assert.equal(f.w.store.get(f.action.id).memberResultFailures, 2);
  assert.equal(f.sends(), before);
  await f.service.reconcile();
  assert.equal(f.service.store.member(f.member.id).phase, "completed");
  f.advance(10000);
  assert.equal(await deliverFollowUps(f.w, f.w.store.get(f.action.id)), true);
  assert.equal(f.sends(), before + 1);
  current = f.w.store.get(f.action.id);
  const attempt = f.assistants.ledger.getAttempt(current.memberResult.attemptId);
  const request = f.assistants.ledger.getRequest(attempt.requestId);
  assert.equal(request.clientRequestId, `coding-result:${f.action.id}`);
  assert.deepEqual(f.service.store.context(request.id), {
    kind: "coding-result",
    teamId: f.member.teamId,
    memberId: f.member.id,
    teamAllowed: false,
  });
  assert.equal(await deliverFollowUps(f.w, current), true);
  assert.equal(f.sends(), before + 1);
});

test("a non-retryable delivery error is recorded and settles", async (t) => {
  const f = await setup(t);
  f.w.a = Object.create(f.assistants, {
    send: {
      value: async () => {
        throw Object.assign(Error("invalid"), { status: 400 });
      },
    },
  });
  assert.equal(await deliverFollowUps(f.w, f.action), true);
  assert.deepEqual(f.w.store.get(f.action.id).memberResult, {
    skipped: "DELIVERY_FAILED",
  });
});
