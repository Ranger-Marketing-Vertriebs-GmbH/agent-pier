import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { ProjectRebind } from "../../server/application/project-rebind.js";
import { projectScope } from "../../server/features/memory/project-scope.js";

function gitInit(cwd) {
  execFileSync("git", ["init", "-q", cwd], {
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

function coordinator(f) {
  // Exercise the actual application identity migration. This fixture has no SSH
  // access, artifacts or persisted coding sessions to migrate.
  const rebind = new ProjectRebind({
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
  });
  f.memory.rebindProject = (input) => rebind.rebind(input);
  return rebind;
}

async function codingProposal(f) {
  return f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Inspect the originally authorized project only.",
  });
}

async function approve(f, proposal) {
  return f.workflows.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve" },
    { kind: "owner" },
  );
}

async function refusesMovedGrant(f, policy, current) {
  assert.deepEqual(
    f.workflows.access.get(f.id),
    policy,
    "migration cannot rewrite grants",
  );
  assert.equal(f.memory.reboundTo(f.project.id), current.id);
  assert.throws(() => f.memory.project(f.project.id), { status: 404 });
  for (const [projectId, status] of [
    [f.project.id, 404],
    [current.id, 403],
  ]) {
    await assert.rejects(
      f.workflows.invoke(await f.invocation(), {
        action: "memory_search",
        projectId,
      }),
      { status },
    );
    await assert.rejects(
      f.workflows.invoke(await f.invocation(), {
        action: "coding_start",
        projectId,
        pipelineId: f.pipeline.id,
        task: "Do not follow a project alias implicitly.",
      }),
      { status },
    );
  }
  const catalog = await f.workflows.invoke(await f.invocation(), { action: "catalog" });
  assert.deepEqual(catalog.projects, []);
}

test("git init before registration blocks an approved coding start against the old identity", async (t) => {
  const f = await workflowFixture(t);
  const policy = f.workflows.access.save(f.id, f.policy, 0);
  const proposal = await codingProposal(f);
  await approve(f, proposal);
  gitInit(f.project.cwd);
  const current = await projectScope(f.project.cwd);
  assert.notEqual(current.id, f.project.id);
  assert.equal(f.memory.hasProject(f.project.id), true, "old metadata still exists");
  assert.equal(
    f.memory.hasProject(current.id),
    false,
    "registration has not repaired it",
  );
  await f.workflows.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.workflows.get(proposal.id).state, "failed");
  assert.equal(f.workflows.coding.receipt(f.workflows.get(proposal.id)), undefined);
  assert.deepEqual(f.workflows.access.get(f.id), policy);
});

test("git-init rebind moves knowledge without granting assistants the replacement identity", async (t) => {
  const f = await workflowFixture(t);
  coordinator(f);
  const note = f.memory.write(f.project.id, {
    title: "Before",
    content: "Original note",
  });
  const policy = f.workflows.access.save(f.id, f.policy, 0);
  const pending = await codingProposal(f);
  const approved = await codingProposal(f);
  await approve(f, approved);
  gitInit(f.project.cwd);
  const current = await f.memory.register(f.project.cwd);
  assert.equal(current.kind, "git");
  assert.equal(f.memory.read(current.id, note.id).content, "Original note");
  await refusesMovedGrant(f, policy, current);
  await assert.rejects(approve(f, pending), { status: 404 });
  // The refused approval closes the proposal instead of leaving it pending.
  assert.equal(f.workflows.get(pending.id).diagnostic, "GRANT_REVOKED");
  await f.workflows.tick();
  assert.equal(f.workflows.get(approved.id).state, "failed");
  assert.equal(f.starts.length, 0);

  // Explicitly saving access to the new identity restores reads, but does not
  // revive either proposal captured with the previous grant revision.
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [current.id] },
    policy.revision,
  );
  const read = await f.workflows.invoke(await f.invocation(), {
    action: "memory_read",
    projectId: current.id,
    id: note.id,
  });
  assert.equal(read.content, "Original note");
  await assert.rejects(approve(f, pending), { status: 409 });
  assert.equal(f.workflows.get(pending.id).state, "failed");
  await f.workflows.tick();
  assert.equal(f.starts.length, 0);
});

test("duplicate merge preserves stale assistant grants and blocks already approved work", async (t) => {
  const f = await workflowFixture(t);
  const rebind = coordinator(f);
  const oldNote = f.memory.write(f.project.id, {
    title: "Old knowledge",
    content: "ORIGINAL_PROJECT_ONLY",
  });
  const policy = f.workflows.access.save(f.id, f.policy, 0);
  const pending = await codingProposal(f);
  const approved = await codingProposal(f);
  await approve(f, approved);
  const memoryProposal = await f.workflows.invoke(await f.invocation(), {
    action: "memory_write",
    projectId: f.project.id,
    title: "Stale proposal",
    content: "Must never write to the replacement project.",
  });
  // Keep the previous directory alive so the replacement cannot reuse its inode.
  fs.renameSync(f.project.cwd, path.join(f.dataDir, "previous-project"));
  fs.mkdirSync(f.project.cwd);
  const current = await f.memory.register(f.project.cwd);
  assert.notEqual(current.id, f.project.id);
  const privateNote = f.memory.write(current.id, {
    title: "Replacement knowledge",
    content: "REPLACEMENT_PROJECT_SECRET",
  });
  await f.workflows.tick();
  assert.equal(f.workflows.get(approved.id).state, "failed");
  assert.equal(f.starts.length, 0, "changed physical identity blocks start before merge");
  const approvedAtMerge = await codingProposal(f);
  await approve(f, approvedAtMerge);
  await approve(f, memoryProposal);

  // This models the owner's explicit merge after the duplicate preview; it uses
  // the real coordinator/memory transaction, with no assistant permission update.
  await rebind.mergeDuplicate(f.project.id, f.memory.scopeOf(current.id));
  assert.equal(f.memory.pendingMerge(f.project.id), null);
  assert.equal(f.memory.read(current.id, oldNote.id).content, "ORIGINAL_PROJECT_ONLY");
  await refusesMovedGrant(f, policy, current);
  await assert.rejects(approve(f, pending), { status: 404 });
  await assert.rejects(
    f.workflows.invoke(await f.invocation(), {
      action: "memory_read",
      projectId: current.id,
      id: privateNote.id,
    }),
    { status: 403 },
  );
  await f.workflows.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.workflows.get(approved.id).state, "failed");
  assert.equal(f.workflows.get(approvedAtMerge.id).state, "failed");
  assert.equal(
    f.workflows.coding.receipt(f.workflows.get(approvedAtMerge.id)),
    undefined,
  );
  assert.equal(f.workflows.get(memoryProposal.id).state, "failed");
  assert.equal(
    f.memory.list(current.id).items.some((item) => item.title === "Stale proposal"),
    false,
  );
});
