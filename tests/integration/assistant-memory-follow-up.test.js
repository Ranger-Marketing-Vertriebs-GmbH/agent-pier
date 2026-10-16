import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";

// An agent's project-knowledge write (agentpier_workspace memory_write) waits for
// the owner; when it is declined or expires the agent hears back, so it never
// keeps believing the note was stored.
async function followUpFixture(t) {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const sends = [];
  const send = f.assistants.send;
  f.assistants.send = async (conversationId, input, context) => {
    if (context?.kind === "memory-result") sends.push({ conversationId, input, context });
    return send(conversationId, input, context);
  };
  const request = async (key, title) => {
    const inv = await f.invocation(key, { kind: "owner" });
    const action = await f.workflows.invoke(inv, {
      action: "memory_write",
      projectId: f.project.id,
      title,
      content: "Plan: VLAN 10 for servers, VLAN 20 for IoT.",
    });
    assert.equal(action.state, "awaiting_approval");
    f.assistants.ledger.transition(inv.attemptId, "completed");
    return action;
  };
  return { ...f, sends, request };
}

test("a declined project-memory write is reported back to the requesting agent once", async (t) => {
  const f = await followUpFixture(t);
  const action = await f.request("declined-note", "Network plan");
  await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "decline" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(f.sends.length, 1);
  const [sent] = f.sends;
  assert.equal(sent.conversationId, f.channel.conversationId);
  assert.equal(sent.input.clientRequestId, `memory-followup:${action.id}`);
  assert.match(sent.input.text, /"Network plan"/);
  assert.match(sent.input.text, /was not saved/);
  assert.match(sent.input.text, /declined/);
  assert.match(sent.input.text, /not a new instruction or permission/);
  assert.equal(f.workflows.get(action.id).settled, true);
  assert.equal(f.memory.list(f.project.id).total, 0);
});

test("an expired project-memory write is reported back; an approved one is not", async (t) => {
  const f = await followUpFixture(t);
  const expired = await f.request("expired-note", "DNS plan");
  f.workflows.store.patch(expired.id, { expiresAt: Date.now() - 1 });
  const approved = await f.request("approved-note", "Router plan");
  await f.workflows.decide(
    approved.id,
    { revision: approved.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  assert.equal(f.workflows.get(expired.id).state, "expired");
  assert.equal(f.workflows.get(approved.id).state, "completed");
  assert.deepEqual(
    f.sends.map((s) => s.input.clientRequestId),
    [`memory-followup:${expired.id}`],
  );
  assert.match(f.sends[0].input.text, /"DNS plan"/);
  assert.match(f.sends[0].input.text, /expired/);
});
