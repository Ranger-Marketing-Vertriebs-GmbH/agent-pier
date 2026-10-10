import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";

const notes = async (f) =>
  (await conversationHistory(f.assistants, f.channel.conversationId)).messages.filter(
    (m) => m.role === "event" && m.event === "coding-run",
  );

async function startRun(f) {
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Implement feature",
  });
  await f.workflows.tick();
  await f.workflows.tick();
  return f.workflows.get(a.id);
}

test("an agent coding run reports its start and completion in the agent chat once", async (t) => {
  const f = await workflowFixture(t);
  const action = await startRun(f);
  const sends = f.sent.length;
  let found = await notes(f);
  assert.equal(found.length, 1);
  assert.equal(found[0].phase, "started");
  assert.equal(found[0].runId, action.runId);
  assert.equal(found[0].pipelineName, "Build");
  assert.equal(found[0].projectName, f.project.name);
  f.runs.get(action.runId).status = "completed";
  await f.workflows.tick();
  await f.workflows.tick();
  found = await notes(f);
  assert.deepEqual(
    found.map((n) => [n.phase, n.state]),
    [
      ["started", "running"],
      ["result", "completed"],
    ],
  );
  assert.ok(found[1].timestamp >= found[0].timestamp);
  const stamp = found[1].timestamp;
  await f.workflows.tick();
  found = await notes(f);
  assert.equal(found.length, 2, "notes are recorded once");
  assert.equal(found[1].timestamp, stamp);
  assert.equal(f.sent.length, sends, "notes are never sent to the agent as user turns");
  assert.ok(
    (await conversationHistory(f.assistants, f.channel.conversationId)).messages.every(
      (m) => m.role !== "user" || !m.text.includes(action.runId),
    ),
  );
});

test("a failed coding run reports its failure in the agent chat", async (t) => {
  const f = await workflowFixture(t);
  const action = await startRun(f);
  f.runs.get(action.runId).status = "failed";
  await f.workflows.tick();
  const found = await notes(f);
  assert.equal(found.at(-1).phase, "result");
  assert.equal(found.at(-1).state, "failed");
  assert.equal(found.at(-1).runId, action.runId);
});

test("a team member's coding run reports its outcome in the parent chat", async (t) => {
  const f = await workflowFixture(t);
  f.assistants.teams.store.find = () => null;
  const a = f.workflows.store.reserve({
    assistantId: f.id,
    conversationId: f.channel.conversationId,
    attemptId: "attempt",
    origin: { kind: "team-member", teamId: "team", memberId: "member" },
    payload: { action: "coding_start", projectId: "p", pipelineId: "q", task: "Fix" },
    key: "member-run",
    state: "completed",
    requestedBy: "member",
    teamId: "team",
    memberName: "Ada",
    projectName: "Project",
    pipelineName: "Build",
    runId: "run",
    run: { id: "run", status: "completed", url: "/pipelines/runs/run" },
    memberResult: { skipped: "TEST" },
  });
  await f.workflows.advanceAction(f.workflows.get(a.id));
  const found = await notes(f);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, "completed");
  assert.equal(found[0].memberName, "Ada");
});

test("the agent's action list shows the live run instead of an old snapshot", async (t) => {
  const f = await workflowFixture(t);
  const action = await startRun(f);
  const run = f.runs.get(action.runId);
  run.status = "completed";
  await f.workflows.tick();
  await f.workflows.tick();
  // The stored snapshot was taken while the stage still reported running.
  run.nodes[0].status = "passed";
  const listed = f.workflows.list(f.id).actions.find((a) => a.id === action.id);
  assert.equal(listed.run.status, "completed");
  assert.equal(listed.run.nodes[0].status, "passed");
  f.runs.delete(action.runId);
  const kept = f.workflows.list(f.id).actions.find((a) => a.id === action.id);
  assert.equal(kept.run.nodes[0].status, "running", "a removed run keeps its snapshot");
});
