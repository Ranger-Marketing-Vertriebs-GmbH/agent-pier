import test from "node:test";
import assert from "node:assert/strict";
import { groupLead } from "../helpers/member-group-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// A group of the lead's first two permanent members.
async function research(t) {
  const f = await groupLead(t);
  const [a, b] = f.permanents;
  const groupId = await f.create("Research");
  await f.move(a.id, groupId);
  await f.move(b.id, groupId);
  return { ...f, a, b, groupId };
}
const finish = async (f) => {
  f.idle();
  await f.service.reconcile();
  await f.service.reconcile();
};
const resultOf = (followUp) =>
  JSON.parse(followUp.text.slice(followUp.text.indexOf("\n")));

test("a task to a group fans out in parallel and reaches the lead once with all results", async (t) => {
  const f = await research(t);
  const sendsBefore = f.sends().length;
  const result = await f.delegate(f.groupId);
  assert.equal(result.status, "delegated");
  assert.equal(result.group, "Research");
  assert.equal(result.tasks.length, 2);
  const parts = f.parts(result.groupTaskId);
  assert.deepEqual(
    parts.map((r) => r.memberId),
    [f.a.id, f.b.id],
  );
  // Both members work at the same time, each in its own chat, as an ordinary task.
  assert.deepEqual(
    parts.map((r) => r.phase),
    ["running", "running"],
  );
  assert.equal(f.sends().length, sendsBefore + 2);
  assert.ok(parts.every((r) => r.type === "task" && r.groupTask.name === "Research"));
  assert.equal(parts.filter((r) => r.groupTask.anchor).length, 1);
  // The first part ends: no follow-up yet.
  f.complete(parts[0].attemptId, "ok", ["Budget is 10k"]);
  await finish(f);
  assert.equal(f.followUps().length, 0);
  // The second ends: one follow-up with both results, for one summary.
  f.complete(parts[1].attemptId, "ok", ["Budget is 12k"]);
  await finish(f);
  const [followUp] = f.followUps();
  assert.equal(f.followUps().length, 1);
  assert.match(followUp.text, /task for the group "Research"/);
  assert.match(followUp.text, /one short summary/);
  const data = resultOf(followUp);
  assert.equal(data.group, "Research");
  assert.equal(data.task, "Check the budget");
  assert.deepEqual(
    data.results.map((x) => [x.member, x.phase, x.result]),
    [
      ["Member 1", "completed", "Budget is 10k"],
      ["Member 2", "completed", "Budget is 12k"],
    ],
  );
  // The turn is a member-result turn for the group, the anchor's delivery.
  const context = f.service.store.context(followUp.id);
  assert.equal(context.kind, "member-result");
  assert.equal(context.groupTaskId, result.groupTaskId);
  assert.equal(context.group, "Research");
  // Every part settles; the others never get their own follow-up.
  f.complete(f.service.requests.store.get(parts[0].id).resultAttemptId);
  await finish(f);
  const settled = f.parts(result.groupTaskId);
  assert.ok(settled.every((r) => r.settled));
  assert.deepEqual(
    settled.map((r) => r.delivery),
    ["sent", "group"],
  );
  assert.equal(f.followUps().length, 1);
  // Each member's own result stays readable on its own.
  assert.equal(f.service.requestDetail(parts[1].id).answer, "Budget is 12k");
  assert.equal(f.service.requestDetail(parts[1].id).groupTask.name, "Research");
});

test("a failed or timed-out part still ends the group task with the others' results", async (t) => {
  const f = await research(t);
  const { groupTaskId } = await f.delegate(f.groupId);
  const [first, second] = f.parts(groupTaskId);
  f.complete(first.attemptId, "ok", ["Found it"]);
  // The second member's run fails: the group does not wait forever.
  f.complete(second.attemptId, "error");
  await finish(f);
  assert.equal(f.followUps().length, 1);
  const text = f.followUps()[0].text;
  assert.match(text, /1 of them ended without a finished result/);
  const results = resultOf(f.followUps()[0]).results;
  assert.equal(results[0].phase, "completed");
  assert.equal(results[1].phase, "failed");
  assert.ok(results[1].reason);
});

test("a part stopped at its time limit counts as ended", async (t) => {
  const f = await research(t);
  const { groupTaskId } = await f.delegate(f.groupId);
  const [first, second] = f.parts(groupTaskId);
  f.complete(first.attemptId);
  // The deadline passed: AgentPier cancels the run, and it ends cancelled.
  f.service.store.write(f.service.requests.store.get(second.id), {
    startedAt: new Date(Date.now() - 24 * 3600000).toISOString(),
  });
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(second.id).cancelledBy, "deadline");
  f.complete(second.attemptId, "error");
  await finish(f);
  const results = resultOf(f.followUps()[0]).results;
  assert.equal(results[0].phase, "completed");
  assert.equal(results[1].diagnostic, "DEADLINE");
  assert.ok(results[1].timeLimitMinutes > 0);
});

test("a member moved during a running group task finishes it for the original group", async (t) => {
  const f = await research(t);
  const { groupTaskId } = await f.delegate(f.groupId);
  const build = await f.create("Build");
  // The move does not stop the member's running part.
  await f.move(f.a.id, build);
  const [first, second] = f.parts(groupTaskId);
  assert.equal(f.service.requests.store.get(first.id).phase, "running");
  assert.ok(!f.calls.some((c) => c.method === "sessions.abort"));
  f.complete(first.attemptId, "ok", ["Moved but done"]);
  f.complete(second.attemptId, "ok", ["Stayed and done"]);
  await finish(f);
  const data = resultOf(f.followUps()[0]);
  assert.equal(data.group, "Research");
  assert.deepEqual(
    data.results.map((x) => x.result),
    ["Moved but done", "Stayed and done"],
  );
  // Later group tasks follow the new membership.
  f.service.store.write(f.service.requests.store.get(first.id), { settled: true });
  const next = await f.delegate(f.groupId, f.turn(), "Next");
  assert.deepEqual(
    f.parts(next.groupTaskId).map((r) => r.memberId),
    [f.b.id],
  );
});

test("a task to an empty group is refused with a clear code", async (t) => {
  const f = await groupLead(t);
  const empty = await f.create("Empty");
  await assert.rejects(f.delegate(empty), (error) => {
    assert.equal(error.key, "memberGroupEmpty");
    assert.equal(toolError(error).code, "GROUP_EMPTY");
    return true;
  });
  assert.equal(f.requests().length, 0);
  await assert.rejects(f.delegate("missing"), { key: "memberGroupNotFound" });
});

test("a group with a busy member gets no part at all", async (t) => {
  const f = await research(t);
  await f.service.delegate(f.turn(), { memberId: f.b.id, task: "Something else" });
  const before = f.requests().length;
  await assert.rejects(f.delegate(f.groupId), (error) => {
    assert.equal(toolError(error).code, "GROUP_MEMBER_BUSY");
    return true;
  });
  assert.equal(f.requests().length, before);
});

test("a retried group task call creates its parts once", async (t) => {
  const f = await research(t);
  const inv = f.turn();
  const first = await f.delegate(f.groupId, inv);
  const again = await f.delegate(f.groupId, inv);
  assert.equal(again.groupTaskId, first.groupTaskId);
  assert.equal(f.parts(first.groupTaskId).length, 2);
});

test("parts the lead cancels end the group task without a follow-up", async (t) => {
  const f = await research(t);
  const inv = f.turn();
  const { groupTaskId } = await f.delegate(f.groupId, inv);
  for (const r of f.parts(groupTaskId)) {
    await f.service.cancel(inv, { requestId: r.id });
    f.complete(r.attemptId, "error");
  }
  await finish(f);
  assert.equal(f.followUps().length, 0);
  assert.ok(f.parts(groupTaskId).every((r) => r.settled));
});

test("the owner cancelling one part still brings the others' results", async (t) => {
  const f = await research(t);
  const { groupTaskId } = await f.delegate(f.groupId);
  const [first, second] = f.parts(groupTaskId);
  await f.service.cancelRequest(first.id);
  f.complete(first.attemptId, "error");
  f.complete(second.attemptId, "ok", ["Done"]);
  await finish(f);
  const results = resultOf(f.followUps()[0]).results;
  assert.equal(results[0].diagnostic, "OWNER_CANCELLED");
  assert.equal(results[1].result, "Done");
});
