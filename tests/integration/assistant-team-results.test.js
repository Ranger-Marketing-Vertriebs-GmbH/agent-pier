import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
test("terminal results queue one synthesis behind a busy parent and preserve partial failures", async (t) => {
  const f = teamFixture(t),
    { team, attempt, chat } = await f.proposal();
  await f.service.reconcile();
  const members = f.service.store.members(team.id);
  members.forEach((m, n) => f.complete(m.attemptId, n ? "ok" : "error"));
  await f.service.reconcile();
  assert.equal(f.runs.size, 4);
  assert.ok(f.service.store.get(team.id).resultBatch);
  f.assistants.ledger.transition(attempt.id, "failed");
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(f.runs.size, 5);
  const synthesis = f.assistants.ledger
    .requests(chat.id)
    .find((r) => r.clientRequestId === `team-result:${team.id}`);
  assert.ok(synthesis.text.includes("failed"));
  assert.equal(f.service.store.context(synthesis.id).kind, "team-result");
  assert.equal(f.service.store.list().length, 1);
});
test("lost synthesis acknowledgement is retained as uncertainty, never resubmitted", async (t) => {
  const f = teamFixture(t),
    { team, attempt } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  f.complete(f.service.store.members(team.id)[0].attemptId);
  f.assistants.ledger.transition(attempt.id, "completed");
  f.loseSend();
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(f.calls.filter((c) => c.method === "sessions.send").length, 2);
  assert.equal(f.service.store.get(team.id).resultState, "uncertain");
});
test("the internal synthesis turn is hidden from the owner's visible history", async (t) => {
  const f = teamFixture(t),
    { team, attempt, chat } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  f.complete(f.service.store.members(team.id)[0].attemptId);
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  await f.service.reconcile();
  const synthesis = f.assistants.ledger
    .requests(chat.id)
    .find((r) => r.clientRequestId === `team-result:${team.id}`);
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) =>
    method === "chat.history" && input.sessionKey === chat.runtimeSessionKey
      ? {
          messages: [
            { role: "user", content: "Team", timestamp: 1, __openclaw: { id: "u1" } },
            {
              role: "user",
              content: synthesis.text,
              timestamp: 2,
              __openclaw: { id: "u2" },
            },
            {
              role: "assistant",
              content: "Summary for you",
              timestamp: 3,
              __openclaw: { id: "a1", runId: synthesis.id },
            },
          ],
        }
      : call(method, input);
  const history = await f.assistants.history(chat.id);
  assert.deepEqual(
    history.messages.map((m) => [m.role, m.event || m.text]),
    [
      ["user", "Team"],
      ["event", "team-result"],
      ["assistant", "Summary for you"],
    ],
  );
  assert.ok(!JSON.stringify(history).includes("Summarize the following"));
  const visible = history.requests.find((r) => r.id === synthesis.id);
  assert.equal(visible.internal, "team-result");
  assert.equal(visible.text, undefined);
  // The durable ledger keeps the exact instruction for audit.
  assert.ok(f.assistants.ledger.getRequest(synthesis.id).text.includes("Summarize"));
});
test("an owner stop after some members completed ends cancelled and still synthesizes their reports", async (t) => {
  const f = teamFixture(t),
    { team, attempt, chat } = await f.proposal({ count: 2 });
  await f.service.reconcile();
  const [done] = f.service.store.members(team.id);
  f.complete(done.attemptId);
  await f.service.reconcile();
  assert.equal(f.service.store.member(done.id).phase, "completed");
  await f.service.stop(team.id);
  for (const m of f.service.store.members(team.id))
    if (m.id !== done.id) f.complete(m.attemptId, "error");
  await f.service.reconcile();
  assert.deepEqual(
    f.service.store
      .members(team.id)
      .map((m) => m.phase)
      .sort(),
    ["cancelled", "completed"],
  );
  assert.equal(f.service.store.get(team.id).phase, "cancelled");
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  await f.service.reconcile();
  const current = f.service.store.get(team.id);
  assert.notEqual(current.resultState, "skipped");
  const synthesis = f.assistants.ledger
    .requests(chat.id)
    .find((r) => r.clientRequestId === `team-result:${team.id}`);
  assert.ok(synthesis, "partial results are synthesized");
});
test("an owner stop before any member completed skips the synthesis", async (t) => {
  const f = teamFixture(t),
    { team, attempt } = await f.proposal({ count: 2 });
  await f.service.reconcile();
  await f.service.stop(team.id);
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId, "error");
  await f.service.reconcile();
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  const current = f.service.store.get(team.id);
  assert.equal(current.phase, "cancelled");
  assert.equal(current.resultState, "skipped");
  assert.equal(current.resultDiagnostic, "TEAM_CANCELLED");
});
