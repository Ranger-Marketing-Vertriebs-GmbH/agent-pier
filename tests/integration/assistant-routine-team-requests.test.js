import test from "node:test";
import assert from "node:assert/strict";
import { until, writeGate } from "../helpers/lead-request-service-fixture.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";

// The fixture's lead with an enabled routine "Morning check": its run session has
// no ledger attempt, so the bridge binds the call to the routine instead.
async function routineLead(t) {
  const f = await writeGate(t);
  const lead = f.store.getAssistant(f.parent.id);
  f.store.updateAssistant(
    lead.id,
    { capabilities: { ...lead.capabilities, memory: true, reminders: true } },
    lead.revision,
  );
  const session = `agent:${lead.runtimeAgentId}:cron:job-1:run:r1`;
  const routine = {
    on: true,
    binding: { id: "binding-1", definition: { name: "Morning check" } },
  };
  f.assistants.routines = {
    results: { forConversation: () => [] },
    runOrigin: (a, key) =>
      routine.on && a.id === lead.id && key === session
        ? { binding: routine.binding, conversation: f.chat }
        : null,
  };
  const call = async (action, input, sessionKey = session) => {
    const { ticket } = f.bridge.prepare({
      agentId: lead.runtimeAgentId,
      sessionKey,
      toolCallId: crypto.randomUUID(),
      action,
    });
    return f.bridge.invoke({ ticket, action, input });
  };
  return { ...f, lead, session, routine, call };
}

test("a routine run is offered the lead's ask, delegate and members tools", () => {
  for (const tool of [
    "agentpier_team_ask",
    "agentpier_team_delegate",
    "agentpier_team_members",
  ])
    assert.ok(routineTools.includes(tool), tool);
  for (const tool of [
    "agentpier_team_propose",
    "agentpier_team_archive",
    "agentpier_team_grant",
    "agentpier_team_cancel",
    "agentpier_workspace",
  ])
    assert.equal(routineTools.includes(tool), false, tool);
});

test("a routine asks a member and gets the answer to relay", async (t) => {
  const f = await routineLead(t);
  const listed = await f.call("members", {});
  assert.deepEqual(
    listed.members.map((m) => m.memberId).sort(),
    [f.temporary.id, f.permanent.id].sort(),
  );
  const pending = f.call("ask", {
    memberId: f.temporary.id,
    question: "What is the budget?",
  });
  const r = await until(() => f.requests().find((x) => x.phase === "running"));
  assert.deepEqual(r.origin, {
    kind: "routine",
    bindingId: "binding-1",
    name: "Morning check",
  });
  assert.match(f.sends().at(-1).input.message, /What is the budget\?$/);
  f.complete(r.attemptId);
  await f.service.reconcile();
  const result = await pending;
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Result from member");
  const card = f.service.requests.list(f.parent.id).at(-1);
  assert.equal(card.routine, "Morning check");
});

test("a task a routine delegates cannot write in the member's workspace", async (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    await t.test(usage, async (t) => {
      const f = await routineLead(t);
      const policy = f.service.store.policy(f.parent.id);
      f.service.store.savePolicy(f.parent.id, { usage }, policy.revision);
      const result = await f.call("delegate", {
        memberId: f.permanent.id,
        task: "Draft the plan",
        ownerRequested: true,
        ownerRequestQuote: `delegate the plan to ${f.member.name}`,
      });
      assert.equal(result.mayWrite, false);
      const r = f.service.requests.store.get(result.requestId);
      assert.equal(r.phase, "running");
      // The member's own run: neither its workspace nor its memory.
      assert.equal(f.write(), false);
      assert.equal(f.write("MEMORY.md"), false);
    });
  }
});

test("a routine is refused for archived and temporary members as in chat", async (t) => {
  const f = await routineLead(t);
  await assert.rejects(
    f.call("delegate", { memberId: f.temporary.id, task: "Draft the plan" }),
    { key: "memberRequestNotPermanent" },
  );
  await f.service.lifecycle(
    "archive",
    f.temporary.id,
    f.service.store.member(f.temporary.id).revision,
  );
  await assert.rejects(
    f.call("ask", { memberId: f.temporary.id, question: "Still there?" }),
    { status: 404 },
  );
});

test("only a current routine run reaches the team tools, and never the rest", async (t) => {
  const f = await routineLead(t);
  for (const action of ["propose", "archive", "grant", "cancel", "workspace"])
    assert.throws(
      () =>
        f.bridge.prepare({
          agentId: f.lead.runtimeAgentId,
          sessionKey: f.session,
          toolCallId: crypto.randomUUID(),
          action,
        }),
      { status: 403 },
      action,
    );
  // Another session of the agent, or the routine switched off, is no routine run.
  await assert.rejects(
    f.call(
      "ask",
      { memberId: f.temporary.id, question: "?" },
      `agent:${f.lead.runtimeAgentId}:cron:job-2:run:r1`,
    ),
    { status: 403 },
  );
  f.routine.on = false;
  await assert.rejects(f.call("ask", { memberId: f.temporary.id, question: "?" }), {
    status: 403,
  });
});
