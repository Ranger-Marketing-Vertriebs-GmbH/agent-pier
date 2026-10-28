import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import {
  grantCreatedProject,
  setCreatedProjectCoding,
} from "../../server/features/assistants/agent-project-grants.js";

// The narrow grant of a project an agent created (agent-project-grants.js) never
// touches what the agent's pending approvals are bound to.
async function created(f, name = "created") {
  const cwd = path.join(f.dataDir, name);
  fs.mkdirSync(cwd);
  return f.memory.register(cwd);
}

test("a created project's grant keeps pending approvals and pipeline hashes valid", async (t) => {
  const f = await workflowFixture(t);
  const access = f.workflows.access;
  const saved = access.save(f.id, f.policy, 0);
  assert.equal(typeof saved.definitions[f.pipeline.id], "string");
  const pending = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Build the feature.",
  });
  assert.equal(pending.state, "awaiting_approval");
  const before = access.stored(f.id);

  const project = await created(f);
  assert.throws(
    () => grantCreatedProject(access, f.id, "never-registered"),
    (e) => e.key === "projectFolderNotGranted",
  );
  const granted = grantCreatedProject(access, f.id, project.id, { coding: true }).policy;
  const switched = setCreatedProjectCoding(access, f.id, project.id, false).policy;
  for (const after of [granted, switched]) {
    assert.deepEqual(after.definitions, before.definitions, "no pipeline re-approved");
    assert.deepEqual(after.pipelineIds, before.pipelineIds);
    assert.equal(after.approvalRevision, before.approvalRevision ?? before.revision);
  }
  assert.equal(switched.revision, before.revision + 2);
  // The pending card still authorizes against the policy as it is now.
  const action = f.workflows.store.get(pending.id);
  assert.equal(action.state, "awaiting_approval");
  access.authorize(f.id, f.project.id, f.pipeline.id, action.accessRevision);

  await f.workflows.decide(
    pending.id,
    { revision: pending.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  assert.equal(f.starts.length, 1, "the approved request starts");
  assert.notEqual(f.workflows.get(pending.id).state, "failed");

  // An owner save, by contrast, moves the approval revision on.
  const owner = access.save(f.id, { ...f.policy }, access.stored(f.id).revision);
  assert.notEqual(owner.approvalRevision, before.approvalRevision ?? before.revision);
});
