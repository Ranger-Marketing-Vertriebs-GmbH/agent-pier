import test from "node:test";
import assert from "node:assert/strict";
import { peers } from "../helpers/peer-request-fixture.js";
import { quoteFor } from "../helpers/lead-request-service-fixture.js";
import {
  peerCaller,
  createPeerRequest,
} from "../../server/features/assistants/peer-request-rules.js";
import {
  publicRequest,
  taskWritable,
} from "../../server/features/assistants/lead-request-store.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  loopGuard,
  loopGuardCaps,
} from "../../server/features/assistants/agent-loop-guard.js";

const hour = 3600000;

test("a member asks a sibling; the record names both and stays read-only", async (t) => {
  const f = await peers(t);
  const inv = f.memberTurn(f.permanent);
  const r = f.peerAsk(inv, f.second);
  const sender = f.store.getAssistant(f.permanent.assistantId);
  const target = f.store.getAssistant(f.second.assistantId);
  assert.equal(r.kind, "lead-request");
  assert.equal(r.type, "question");
  assert.equal(r.parentAssistantId, f.parent.id);
  assert.equal(r.parentConversationId, mainConversation(f.store, f.parent.id).id);
  assert.equal(r.parentRequestId, null);
  assert.equal(r.parentAttemptId, null);
  assert.equal(r.memberId, f.second.id);
  assert.equal(r.memberAssistantId, f.second.assistantId);
  assert.equal(r.memberName, target.name);
  assert.equal(r.fromMemberId, f.permanent.id);
  assert.equal(r.fromAssistantId, sender.id);
  assert.equal(r.fromName, sender.name);
  assert.equal(r.fromConversationId, f.permanent.conversationId);
  assert.equal(r.fromAttemptId, inv.attemptId);
  assert.equal(r.resultTo, "me");
  assert.deepEqual(r.origin, { kind: "peer", fromMemberId: f.permanent.id });
  assert.equal(r.writeAllowed, false);
  assert.equal(r.peerWrites, undefined);
  assert.equal(r.ownerProof, null);
  assert.equal(r.phase, "queued");
  assert.equal(r.text, "What did you find?");
  assert.equal(
    r.runTimeoutMinutes,
    f.service.store.policy(f.parent.id).runTimeoutMinutes,
  );
  assert.equal(taskWritable(r), false);
  const card = publicRequest(r);
  assert.equal(card.fromMemberId, f.permanent.id);
  assert.equal(card.fromName, sender.name);
  assert.equal(card.resultTo, "me");
  assert.equal(publicRequest({ ...r, fromMemberId: undefined }).fromName, undefined);
  // A task names where its result goes; anything else is invalid input.
  const task = f.peerDelegate(f.memberTurn(f.second), f.permanent, { resultTo: "lead" });
  assert.equal(task.resultTo, "lead");
  assert.equal(
    f.code(() => f.peerDelegate(f.memberTurn(f.second), f.permanent, { resultTo: "x" })),
    "INVALID_INPUT",
  );
  assert.equal(
    f.code(() => f.peerAsk(f.memberTurn(f.second), f.permanent, { resultTo: "me" })),
    "INVALID_INPUT",
  );
});

test("a lead, another lead's member and the member itself are refused as targets or callers", async (t) => {
  const f = await peers(t);
  // The lead is no member: its own turn cannot call.
  assert.equal(
    f.code(() => f.peerAsk(f.turn(), f.second)),
    "FORBIDDEN",
  );
  assert.throws(() => peerCaller(f.service, f.turn()), { status: 403 });
  const inv = () => f.memberTurn(f.permanent);
  // Itself, the lead and an unknown id are no sibling.
  assert.equal(
    f.code(() => f.peerAsk(inv(), f.permanent)),
    "NOT_FOUND",
  );
  assert.equal(
    f.code(() => f.peerAsk(inv(), { id: f.parent.id })),
    "NOT_FOUND",
  );
  assert.equal(
    f.code(() => f.peerAsk(inv(), { id: "nobody" })),
    "NOT_FOUND",
  );
  // Another lead's member.
  const other = await f.proposal({ count: 1 });
  const stranger = f.service.store.members(other.team.id)[0];
  assert.equal(
    f.code(() => f.peerAsk(inv(), stranger)),
    "NOT_FOUND",
  );
  // An archived sibling is no target; an archived lead ends its members' calls.
  f.archive(f.second.assistantId);
  assert.equal(
    f.code(() => f.peerAsk(inv(), f.second)),
    "NOT_FOUND",
  );
  // An archived member cannot call.
  assert.equal(
    f.code(() => f.peerAsk(f.memberTurn(f.second), f.temporary)),
    "FORBIDDEN",
  );
  f.archive(f.parent.id);
  assert.equal(
    f.code(() => f.peerAsk(inv(), f.temporary)),
    "FORBIDDEN",
  );
});

test("a temporary sibling takes questions and tasks; an ended one with a chat still answers", async (t) => {
  const f = await peers(t);
  assert.ok(f.temporary.conversationId);
  assert.equal(f.temporary.phase, "completed");
  const asked = f.peerAsk(f.memberTurn(f.permanent), f.temporary);
  assert.equal(asked.memberId, f.temporary.id);
  // AGENTPIER-276: temporary members take tasks too.
  assert.equal(f.peerDelegate(f.memberTurn(f.second), f.temporary).type, "task");
  // A temporary member asks a permanent one and may hand it a task.
  assert.equal(f.peerAsk(f.memberTurn(f.temporary), f.second).memberId, f.second.id);
  assert.equal(f.peerDelegate(f.memberTurn(f.temporary), f.permanent).type, "task");
  // Without a chat it can no longer be reached.
  f.service.store.write(f.service.store.member(f.temporary.id), { conversationId: null });
  assert.equal(
    f.code(() => f.peerAsk(f.memberTurn(f.second), f.temporary)),
    "NOT_FOUND",
  );
});

// AGENTPIER-276: a member handling a sibling's request may ask and task others; its
// loop guard (agent-loop-guard.js) bounds a chain or ping-pong instead of PEER_LOOP.
test("a turn handling a peer request may start one; the loop guard bounds a ping-pong", async (t) => {
  const f = await peers(t);
  const r = f.peerAsk(f.memberTurn(f.permanent), f.second);
  const handling = () =>
    f.memberTurn(f.second, { kind: "lead-request", requestId: r.id });
  assert.equal(f.peerAsk(handling(), f.temporary).fromMemberId, f.second.id);
  const guard = loopGuard(f.service.assistants.store);
  guard.caps = { actions: 0, windowMs: 600000 };
  t.after(() => {
    guard.caps = loopGuardCaps;
    guard.times.clear();
  });
  const loop = toolError(
    (() => {
      try {
        f.peerAsk(handling(), f.permanent);
      } catch (error) {
        return error;
      }
    })(),
  );
  assert.equal(loop.code, "AGENT_LOOP_LIMIT");
  assert.equal(loop.status, 429);
});
test("forwarded content and a memory step cannot start one; other turns may", async (t) => {
  const f = await peers(t);
  const r = f.peerAsk(f.memberTurn(f.permanent), f.second);
  for (const context of [
    { kind: "peer-result", requestId: r.id },
    { kind: "reminder" },
    { kind: "unknown" },
  ])
    assert.equal(
      f.code(() => f.finish(f.peerAsk(f.memberTurn(f.permanent, context), f.temporary))),
      null,
      context.kind,
    );
  for (const context of [
    { kind: "telegram", forwarded: true },
    { kind: "owner", forwarded: true },
    { kind: "memory-step" },
  ]) {
    const inv = f.memberTurn(f.permanent, context);
    let error;
    try {
      f.peerAsk(inv, f.temporary);
    } catch (e) {
      error = e;
    }
    const e = toolError(error);
    assert.equal(e.code, "PEER_TURN", context.kind);
    assert.equal(e.status, 403);
    assert.match(e.reason, /Do not retry\./);
  }
  // No turn context at all.
  const bare = f.memberTurn(f.permanent);
  bare.attemptId = null;
  assert.equal(
    f.code(() => f.peerAsk(bare, f.temporary)),
    "FORBIDDEN",
  );
});

test("one open request per pair and direction; the reverse direction is allowed", async (t) => {
  const f = await peers(t);
  const first = f.peerAsk(f.memberTurn(f.permanent), f.second);
  assert.equal(
    f.code(() => f.peerAsk(f.memberTurn(f.permanent), f.second)),
    "PEER_OPEN",
  );
  assert.equal(
    f.code(() => f.peerDelegate(f.memberTurn(f.permanent), f.second)),
    "PEER_OPEN",
  );
  assert.equal(f.peerAsk(f.memberTurn(f.second), f.permanent).fromMemberId, f.second.id);
  // A target with any open task takes no second task, whoever sent the first.
  f.finish(first);
  f.peerDelegate(f.memberTurn(f.temporary), f.second);
  assert.equal(
    f.code(() => f.peerDelegate(f.memberTurn(f.permanent), f.second)),
    "PEER_OPEN",
  );
  // A question still reaches it.
  assert.equal(
    f.code(() => f.peerAsk(f.memberTurn(f.permanent), f.second)),
    null,
  );
});

test("a peer task may write only from a writable sender turn", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  let now = Date.parse("2026-10-23T08:00:00Z");
  // Each row a new hour and a finished task, so caps and open tasks never interfere.
  const send = (inv) => {
    now += hour;
    const r = f.peerDelegate(inv, f.second, {}, now);
    f.finish(r);
    return r;
  };
  const owner = send(f.memberTurn(f.permanent, { kind: "owner" }));
  assert.equal(owner.writeAllowed, true);
  assert.equal(owner.peerWrites.kind, "owner");
  assert.equal(taskWritable(owner), true);
  const telegram = send(f.memberTurn(f.permanent, { kind: "telegram" }));
  assert.equal(telegram.peerWrites.kind, "owner");
  // A question never writes, even from the owner's turn.
  now += hour;
  const question = f.peerAsk(f.memberTurn(f.permanent), f.second, {}, now);
  f.finish(question);
  assert.equal(question.writeAllowed, false);
  assert.equal(question.peerWrites, undefined);
  // An owner-proven lead task running in exactly this attempt.
  const leadTask = async (extra, context) => {
    f.settle();
    const { requestId } = await f.service.delegate(f.turn(undefined, context), {
      memberId: f.permanent.id,
      task: "Draft the plan",
      ...extra,
    });
    const r = f.service.requests.store.get(requestId);
    assert.equal(r.phase, "running");
    return r;
  };
  const proven = await leadTask({
    ownerRequested: true,
    ownerRequestQuote: quoteFor(f.permanent),
  });
  assert.equal(taskWritable(proven), true);
  const lt = send({ attemptId: proven.attemptId, toolCallId: "c1", assertCurrent() {} });
  assert.equal(lt.writeAllowed, true);
  assert.deepEqual(lt.peerWrites, { kind: "lead-task", requestId: proven.id });
  // Another attempt of the same member's chat is not that task's turn.
  const elsewhere = send(
    f.memberTurn(f.permanent, { kind: "lead-request", requestId: proven.id }),
  );
  assert.equal(elsewhere.writeAllowed, false);
  f.finish(proven);
  // A read-only lead task, a lead question and a team assignment run read-only.
  const readOnly = await leadTask({}, { kind: "team-result" });
  assert.equal(readOnly.writeAllowed, false);
  const ro = send({
    attemptId: readOnly.attemptId,
    toolCallId: "c2",
    assertCurrent() {},
  });
  assert.equal(ro.writeAllowed, false);
  assert.equal(ro.peerWrites, undefined);
  f.finish(readOnly);
  f.settle();
  const { requestId } = await f.service.ask(f.turn(), {
    memberId: f.permanent.id,
    question: "What is the budget?",
  });
  const q = f.service.requests.store.get(requestId);
  assert.equal(
    send({ attemptId: q.attemptId, toolCallId: "c3", assertCurrent() {} }).writeAllowed,
    false,
  );
  f.finish(q);
  const assignment = send(
    f.memberTurn(f.permanent, {
      kind: "team-member",
      teamId: f.team.id,
      memberId: f.permanent.id,
    }),
  );
  assert.equal(assignment.writeAllowed, false);
  // A forwarded Telegram message cannot start one at all.
  assert.equal(
    f.code(() =>
      f.peerDelegate(
        f.memberTurn(f.permanent, { kind: "telegram", forwarded: true }),
        f.second,
      ),
    ),
    "PEER_TURN",
  );
  // A restricted user's turn is no turn of the member's own work, even as its user.
  const agent = f.store.getAssistant(f.permanent.assistantId);
  f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
    JSON.stringify({
      ...agent,
      userAccess: { members: [{ userId: "u1", level: "standard" }] },
    }),
    agent.id,
  );
  assert.equal(
    f.code(() =>
      f.peerAsk(f.memberTurn(f.permanent, { kind: "user", userId: "u1" }), f.second),
    ),
    "PEER_TURN",
  );
  // A routine of the permanent member writes when its run may write.
  let writable = true;
  f.assistants.routines = { writable: () => writable };
  const run = (key) => ({
    attemptId: null,
    toolCallId: "c4",
    sessionKey: `agent:x:cron:job-1:run:${key}`,
    routine: {
      binding: {
        id: "binding-1",
        assistantId: f.permanent.assistantId,
        definition: { name: "Morning" },
      },
      conversation: f.store.getConversation(f.permanent.conversationId),
    },
    assertCurrent() {},
  });
  const may = send(run("r1"));
  assert.equal(may.writeAllowed, true);
  assert.deepEqual(may.peerWrites, { kind: "routine", bindingId: "binding-1" });
  assert.equal(may.fromAttemptId, null);
  assert.equal(may.fromConversationId, f.permanent.conversationId);
  writable = false;
  const not = send(run("r2"));
  assert.equal(not.writeAllowed, false);
  // A temporary member's routine run is no caller.
  const temporaryRun = {
    ...run("r3"),
    routine: {
      binding: { id: "binding-t", assistantId: f.temporary.assistantId },
      conversation: f.store.getConversation(f.temporary.conversationId),
    },
  };
  assert.equal(
    f.code(() => f.peerAsk(temporaryRun, f.second)),
    "FORBIDDEN",
  );
  // A routine binding paired with another member's chat is no caller either.
  const foreign = {
    ...run("r4"),
    routine: {
      ...run("r4").routine,
      conversation: f.store.getConversation(f.second.conversationId),
    },
  };
  assert.throws(() => peerCaller(f.service, foreign), { status: 403 });
  assert.equal(
    f.code(() => f.peerAsk(foreign, f.temporary)),
    "FORBIDDEN",
  );
  // A cancelled peer task no longer writes.
  assert.equal(taskWritable({ ...owner, cancelRequested: true }), false);
  assert.equal(taskWritable({ ...owner, type: "question" }), false);
});

test("the same tool call replays; a changed input conflicts", async (t) => {
  const f = await peers(t);
  const inv = f.memberTurn(f.permanent);
  const first = f.peerAsk(inv, f.second);
  assert.equal(f.peerAsk(inv, f.second).id, first.id);
  assert.equal(f.requests().length, 1);
  assert.equal(
    f.code(() => f.peerAsk(inv, f.second, { question: "Other?" })),
    "CONFLICT",
  );
  assert.throws(() => f.peerAsk(inv, f.second, { question: "Other?" }), { status: 409 });
  // A routine run's key is its session.
  f.assistants.routines = { writable: () => false };
  const run = {
    attemptId: null,
    toolCallId: "same",
    sessionKey: "agent:x:cron:job-1:run:r1",
    routine: {
      binding: { id: "binding-1", assistantId: f.permanent.assistantId },
      conversation: f.store.getConversation(f.permanent.conversationId),
    },
  };
  const routine = createPeerRequest(f.service, {
    type: "question",
    inv: run,
    input: { memberId: f.temporary.id, question: "Status?" },
  });
  assert.equal(
    createPeerRequest(f.service, {
      type: "question",
      inv: run,
      input: { memberId: f.temporary.id, question: "Status?" },
    }).id,
    routine.id,
  );
});
