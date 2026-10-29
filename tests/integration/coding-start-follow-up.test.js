import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { startSession } from "../../server/features/assistants/coding-sessions/session-start.js";
import { sessionContext } from "../../server/features/assistants/coding-sessions/session-turns.js";

// Approval tests use shared access, whose starts require a decision even when
// explicit session grants also cover team turns.
async function approvalSessionFixture(t) {
  const f = await agentSessionFixture(t, { sessionProjects: false });
  const lead = f.store.createAssistant({
    name: "Lead",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const w = f.workflows;
  w.access.save(lead.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  const share = {
    leadId: lead.id,
    shareId: "share-1",
    requestId: null,
    kind: "project",
    memberAssistantId: f.id,
    projectId: f.project.id,
  };
  w.shares.coding = () => share;
  w.shares.codingProjects = () => [{ leadId: lead.id, projectId: f.project.id }];
  w.shares.find = () => share;
  w.shares.live = () => ({ coding: true });
  return f;
}

for (const session of [false, true]) {
  test(`approved ${session ? "session" : "pipeline"} wakes its chat once, retrying a busy chat`, async (t) => {
    const f = await (session ? approvalSessionFixture(t) : workflowFixture(t));
    if (!session) f.workflows.access.save(f.id, f.policy, 0);
    const inv = await f.invocation();
    const requested = session
      ? await startSession(
          f.workflows,
          {
            ...sessionContext(f.workflows, inv),
            sessionClass: "team",
          },
          {
            action: "start",
            requestId: crypto.randomUUID(),
            projectId: f.project.id,
            tool: "codex",
          },
        )
      : await f.workflows.invoke(inv, {
          action: "coding_start",
          projectId: f.project.id,
          pipelineId: f.pipeline.id,
          task: "Implement the approved task",
        });
    const action = f.workflows.store.get(requested.actionId || requested.id);
    assert.equal(action.state, "awaiting_approval");
    await f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "approve" },
      { kind: "owner" },
    );
    const sends = [];
    let busy = true;
    f.assistants.send = async (conversationId, input, context) => {
      sends.push({ conversationId, input, context });
      if (busy) throw Object.assign(Error("Busy"), { status: 409 });
      return { attempt: { id: "wake-attempt" } };
    };
    await f.workflows.tick();
    await f.workflows.tick();
    assert.equal(sends.length, 1);
    assert.notEqual(f.workflows.get(action.id).settled, true);
    // Reopen the persisted action store as on restart; the launch and notice
    // must survive even when a pipeline has already finished before delivery.
    f.workflows.store = new AssistantActionStore(f.assistants.store.db);
    if (!session) f.runs.get(f.workflows.get(action.id).runId).status = "completed";
    busy = false;
    f.workflows.now = () => Date.now() + 10000;
    await f.workflows.tick();
    await f.workflows.tick();
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0], sends[1]);
    assert.equal(sends[1].conversationId, f.channel.conversationId);
    assert.equal(sends[1].input.clientRequestId, `coding-start:${action.id}`);
    assert.match(sends[1].input.text, /owner approved/);
    const current = f.workflows.get(action.id);
    assert.equal(current.codingStartDelivered.attemptId, "wake-attempt");
    assert.equal((session ? f.launches : f.starts).length, 1);
    assert.equal(sends[1].context.kind, session ? "coding-session" : "coding-start");
  });
}

test("a pipeline start wake can inspect only its own run and cannot start work", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const inv = await f.invocation();
  const action = await f.workflows.invoke(inv, {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Approved task",
  });
  await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "approve" },
    { kind: "owner" },
  );
  f.assistants.ledger.transition(inv.attemptId, "completed");
  const send = f.assistants.send;
  f.assistants.send = async () => {
    throw Object.assign(Error("Busy"), { status: 409 });
  };
  await f.workflows.tick();
  f.assistants.send = send;
  const wake = await f.invocation(`coding-start:${action.id}`, {
    kind: "coding-start",
    actionId: action.id,
  });
  const status = await f.workflows.invoke(wake, {
    action: "coding_status",
    id: action.id,
  });
  assert.ok(status);
  for (const input of [
    {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Unapproved task",
    },
    { action: "coding_status", id: "another-action" },
    { action: "file_read", projectId: f.project.id, path: "README.md" },
  ])
    await assert.rejects(f.workflows.invoke(wake, input), { status: 403 });
  await assert.rejects(f.workflows.sessions.invoke(wake, { action: "list" }), {
    status: 403,
  });
});

test("a failed approved launch reports failure and does not launch again", async (t) => {
  const f = await approvalSessionFixture(t);
  const inv = await f.invocation();
  const requested = await startSession(
    f.workflows,
    {
      ...sessionContext(f.workflows, inv),
      sessionClass: "team",
    },
    {
      action: "start",
      requestId: crypto.randomUUID(),
      projectId: f.project.id,
      tool: "codex",
    },
  );
  const action = f.workflows.get(requested.actionId);
  await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "approve" },
    { kind: "owner" },
  );
  let launches = 0;
  f.services.launch = async () => {
    launches++;
    throw Object.assign(Error("Launch failed"), { status: 422 });
  };
  const sends = [];
  f.assistants.send = async (_id, input) => {
    sends.push(input);
    return { attempt: { id: "wake" } };
  };
  await f.workflows.tick();
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(launches, 1);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /"state":"failed"/);
  assert.equal(f.workflows.get(action.id).settled, true);
});
