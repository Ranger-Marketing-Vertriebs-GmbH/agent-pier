import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { AssistantWorkflows } from "../../server/features/assistants/assistant-workflows.js";

async function approvedWrite(f, input) {
  const proposal = await f.workflows.invoke(await f.invocation(), {
    action: "memory_write",
    projectId: f.project.id,
    ...input,
  });
  await f.workflows.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  return f.workflows.get(proposal.id);
}
function storedBodies(f) {
  return JSON.stringify(
    f.assistants.store.db.prepare("SELECT body FROM assistant_actions").all(),
  );
}

test("forgetting an entry redacts the approved agent writes that stored it", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const done = await approvedWrite(f, {
    title: "Token",
    content: "fixture-agent-secret",
  });
  assert.equal(done.state, "completed");
  const other = await approvedWrite(f, { title: "Kept", content: "unrelated note" });
  assert.equal(storedBodies(f).includes("fixture-agent-secret"), true);
  const result = f.memory.forget(f.project.id, done.result.id, { expectedRevision: 1 });
  assert.equal(result.purged, true);
  const redacted = f.workflows.get(done.id);
  assert.equal(redacted.state, "completed");
  assert.equal(redacted.payload.title, "");
  assert.equal(redacted.payload.content, "");
  assert.equal(redacted.diagnostic, "MEMORY_FORGOTTEN");
  assert.equal(f.workflows.get(other.id).payload.content, "unrelated note");
  assert.equal(storedBodies(f).includes("fixture-agent-secret"), false);
});

test("agent services started after a forget redact its earlier writes", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const done = await approvedWrite(f, { title: "Token", content: "fixture-late-secret" });
  f.memory.onForget = null; // The agent services were not running.
  f.memory.forget(f.project.id, done.result.id, { expectedRevision: 1 });
  assert.equal(f.workflows.get(done.id).payload.content, "fixture-late-secret");
  const restarted = new AssistantWorkflows({ services: f.services, autoStart: false });
  t.after(() => restarted.close());
  assert.equal(restarted.get(done.id).payload.content, "");
  assert.equal(f.memory.onForget !== null, true);
});

test("an approved write of forgotten text fails definitively instead of staying unknown", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const entry = f.memory.write(f.project.id, { title: "Token", content: "fixture-x" });
  f.memory.forget(f.project.id, entry.id, { expectedRevision: 1 });
  const refused = await approvedWrite(f, { title: "Token", content: "fixture-x" });
  assert.equal(refused.state, "failed");
  assert.equal(refused.diagnostic, "MEMORY_FORGOTTEN");
  assert.equal(storedBodies(f).includes("fixture-x"), false);
});
