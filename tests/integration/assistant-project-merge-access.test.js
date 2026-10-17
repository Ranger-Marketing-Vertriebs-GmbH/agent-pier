import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { ProjectRebind } from "../../server/application/project-rebind.js";
import { saveWork } from "../../server/features/assistants/assistant-work.js";

function coordinator(f, assistantWorkflows = () => f.workflows) {
  return new ProjectRebind({
    dataDir: f.dataDir,
    memory: f.memory,
    sshManagement: {
      ownsProject: () => false,
      knowsProject: () => false,
      adoptProject: async () => {},
    },
    artifacts: { ownsProject: () => false, moveProject: async () => {} },
    sessions: { serial: (fn) => fn() },
    audit: { append() {} },
    assistantWorkflows,
  });
}
const audited = (f) => {
  const events = [];
  f.services.audit.append = (event) => events.push(event);
  return events;
};
async function otherProject(f) {
  const cwd = path.join(f.dataDir, "other");
  fs.mkdirSync(cwd);
  return f.memory.register(cwd);
}
/** Replaces the project folder, so a new current row shares the older row's path. */
async function replaceFolder(f) {
  fs.renameSync(f.project.cwd, path.join(f.dataDir, "previous-project"));
  fs.mkdirSync(f.project.cwd);
  return f.memory.register(f.project.cwd);
}
const work = (f, access) =>
  saveWork(
    {
      assistants: f.assistants,
      access: f.workflows.access,
      teams: { transaction: (fn) => fn(), policy: () => null },
    },
    f.id,
    { access },
  );

test("merging an older project row drops it from agent access and closes its approvals", async (t) => {
  const f = await workflowFixture(t);
  const other = await otherProject(f);
  const policy = f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [f.project.id, other.id] },
    0,
  );
  const stale = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Work on the older row.",
  });
  const kept = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: other.id,
    pipelineId: f.pipeline.id,
    task: "Work on another project.",
  });
  // An SSH card names its host's project, but its authority is the SSH grant: the
  // host moves with the merge, so the card stays open.
  const ssh = f.workflows.store.reserve({
    assistantId: f.id,
    key: "ssh-card",
    state: "awaiting_approval",
    payload: { action: "ssh", accessId: "host", projectId: f.project.id },
  });
  const current = await replaceFolder(f);
  const events = audited(f);
  await coordinator(f).mergeDuplicate(f.project.id, f.memory.scopeOf(current.id));

  const after = f.workflows.access.get(f.id);
  // The replacement row is never granted implicitly; only the older id goes.
  assert.deepEqual(after.projectIds, [other.id]);
  assert.equal(after.revision, policy.revision + 1);
  assert.equal(after.approvalRevision, policy.approvalRevision);
  const closed = f.workflows.get(stale.id);
  assert.equal(closed.state, "failed");
  assert.equal(closed.diagnostic, "GRANT_REVOKED");
  assert.equal(f.workflows.get(kept.id).state, "awaiting_approval");
  assert.equal(f.workflows.get(ssh.id).state, "awaiting_approval");
  assert.deepEqual(
    events.map((e) => [e.action, e.resourceId, e.projectId, e.details]),
    [
      [
        "assistant.updated",
        f.id,
        current.id,
        {
          kind: "project-rebind",
          fromProjectId: f.project.id,
          revision: after.revision,
          count: 1,
        },
      ],
    ],
  );
  // The other project's approval still works, and the owner's next save succeeds.
  const approved = await f.workflows.decide(
    kept.id,
    { revision: kept.revision, decision: "approve" },
    { kind: "owner" },
  );
  assert.equal(approved.state, "approved");
  const saved = f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [other.id], memoryWrite: false },
    after.revision,
  );
  assert.equal(saved.memoryWrite, false);
  // A resumed merge step finds nothing left to drop.
  const count = events.length;
  f.workflows.revokeProject(f.project.id, current.id);
  assert.equal(events.length, count);
  assert.equal(f.workflows.access.get(f.id).revision, saved.revision);
});

test("saving agent access with an unknown project drops it and reports it", async (t) => {
  const f = await workflowFixture(t);
  const other = await otherProject(f);
  const missing = "0".repeat(64);
  // An installation whose merge left a stale id behind.
  f.workflows.access.write(f.id, {
    ...f.workflows.access.get(f.id),
    ...f.policy,
    projectIds: [f.project.id, missing],
  });
  const saved = work(f, {
    revision: 0,
    ...f.policy,
    projectIds: [f.project.id, missing, other.id],
  });
  assert.deepEqual(saved.access.projectIds, [f.project.id, other.id]);
  assert.deepEqual(saved.removedProjectIds, [missing]);
  assert.equal(f.workflows.access.get(f.id).revision, 1);
  const clean = work(f, { revision: 1, ...f.policy });
  assert.deepEqual(clean.removedProjectIds, []);
  // The direct save tolerates it as well; a malformed id is still refused.
  assert.deepEqual(
    f.workflows.access.save(f.id, { ...f.policy, projectIds: [missing] }, 2).projectIds,
    [],
  );
  assert.throws(
    () => f.workflows.access.save(f.id, { ...f.policy, projectIds: ["../x"] }, 3),
    { status: 400 },
  );
});

test("a git-init rebind that could not reach the agents drops their grant on the next resume", async (t) => {
  const f = await workflowFixture(t);
  const policy = f.workflows.access.save(f.id, f.policy, 0);
  // The agent feature is off while the folder becomes a Git work tree.
  let workflows = null;
  const rebind = coordinator(f, () => workflows);
  f.memory.rebindProject = (input) => rebind.rebind(input);
  execFileSync("git", ["init", "-q", f.project.cwd], {
    env: {
      PATH: process.env.PATH,
      HOME: f.project.cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  const current = await f.memory.register(f.project.cwd);
  assert.equal(f.memory.reboundTo(f.project.id), current.id);
  assert.equal(rebind.remnants(f.project.id), false);
  workflows = f.workflows;
  assert.equal(rebind.remnants(f.project.id), true);
  await rebind.ensure({ cwd: f.project.cwd, previousIds: [f.project.id] });
  const after = f.workflows.access.get(f.id);
  assert.deepEqual(after.projectIds, []);
  assert.equal(after.revision, policy.revision + 1);
  assert.equal(rebind.remnants(f.project.id), false);
});

test("the direct access save reports the projects it dropped", async (t) => {
  const f = await workflowFixture(t);
  const missing = "0".repeat(64);
  const saved = f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [f.project.id, missing] },
    0,
  );
  assert.deepEqual(saved.projectIds, [f.project.id]);
  assert.deepEqual(saved.removedProjectIds, [missing]);
  // Only the policy is stored, never the report.
  assert.equal(f.workflows.access.get(f.id).removedProjectIds, undefined);
});
