import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leadShareFixture as setup } from "../helpers/lead-share-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { agentLocalRoot } from "../../server/features/assistants/agent-sftp-local.js";

const code = (key) => (error) => toolError(error).code === key;
const lastFileAudit = (f) => f.audits.findLast((e) => e.details?.kind === "project-file");
// The project folder level the owner grants the member itself, with extra policy.
const own = (f, level, extra = {}) =>
  f.workflows.access.save(
    f.member.assistantId,
    {
      ...f.policy,
      projectIds: [f.folderProject.id],
      projectFiles: { [f.folderProject.id]: level },
      ...extra,
    },
    f.workflows.access.get(f.member.assistantId).revision,
  );
const writable = {
  ownerProof: { quote: "Scout, render it", sentence: 0 },
  writeAllowed: true,
};
const done = (f, task) => f.teams.write(f.teams.get(task.id), { phase: "completed" });
const write = (f, task, name) =>
  f.call(task.inv, { action: "file_write", path: name, content: name });

test("a member's own Read and write folder writes in a writable task of its lead", async (t) => {
  const f = await setup(t);
  own(f, "write");
  const task = await f.task(writable);
  assert.equal((await f.call(task.inv, { action: "files_list" })).access, "write");
  assert.equal((await write(f, task, "own.md")).created, true);
  assert.equal(fs.readFileSync(path.join(f.folder, "own.md"), "utf8"), "own.md");
  // Audited as the member's own grant, in the lead's task.
  const audit = lastFileAudit(f);
  assert.equal(audit.resourceId, f.member.assistantId);
  assert.equal(audit.details.via, "own-grant");
  assert.equal(audit.details.leadRequestId, task.id);
  assert.equal(audit.details.leadAssistantId, f.lead);
  // The SFTP local side follows the same levels.
  const ctx = {
    assistantId: f.member.assistantId,
    leadRequest: { id: task.id, leadId: f.lead, writable: true },
  };
  const spec = agentLocalRoot(f.workflows, ctx, {
    projectId: f.folderProject.id,
    write: true,
  });
  assert.equal(spec.root, f.folder);
  // A cancelled task reaches nothing.
  f.teams.write(f.teams.get(task.id), { cancelRequested: true });
  await assert.rejects(f.call(task.inv, { action: "files_list" }), code("FORBIDDEN"));
});

test("a member's own folders only read in a task of its lead that may not write", async (t) => {
  const f = await setup(t);
  own(f, "write");
  const task = await f.task();
  const listed = await f.call(task.inv, { action: "file_read", path: "README.md" });
  assert.equal(listed.access, "read");
  await assert.rejects(write(f, task, "x.md"), code("PROJECT_READ_ONLY"));
  assert.equal(fs.existsSync(path.join(f.folder, "x.md")), false);
  // The catalog names the folder at the level the task uses.
  const catalog = await f.call(task.inv, { action: "catalog" });
  assert.deepEqual(
    catalog.projects.map((p) => [p.id, p.folder?.access, p.sharedBy]),
    [[f.folderProject.id, "read", undefined]],
  );
  const ctx = {
    assistantId: f.member.assistantId,
    leadRequest: { id: task.id, leadId: f.lead, writable: false },
  };
  assert.throws(
    () =>
      agentLocalRoot(f.workflows, ctx, { projectId: f.folderProject.id, write: true }),
    { key: "projectFolderReadOnly" },
  );
  assert.equal(
    agentLocalRoot(f.workflows, ctx, { projectId: f.folderProject.id }).root,
    f.folder,
  );
  // A question of the lead never writes either.
  done(f, task);
  const question = await f.task({ ...writable, type: "question" });
  await assert.rejects(write(f, question, "q.md"), code("PROJECT_READ_ONLY"));
});

test("a member's own Read folder never writes in a task of its lead", async (t) => {
  const f = await setup(t);
  own(f, "read");
  const task = await f.task(writable);
  assert.equal((await f.call(task.inv, { action: "files_list" })).access, "read");
  await assert.rejects(write(f, task, "x.md"), code("PROJECT_READ_ONLY"));
});

test("own folder and lead share in a lead's task: the higher level counts", async (t) => {
  const f = await setup(t);
  // Own Read, shared Read and write: the share writes, also in a read-only task.
  own(f, "read");
  await f.share({ grants: { projects: { [f.folderProject.id]: "write" } } });
  const readOnly = await f.task();
  assert.equal((await write(f, readOnly, "shared.md")).created, true);
  assert.equal(lastFileAudit(f).details.via, "lead-share");
  done(f, readOnly);
  // Own Read and write, shared Read: reads only in a task that may not write ...
  own(f, "write");
  const projects = { [f.folderProject.id]: "write" };
  await f.share({ grants: { projects }, revoke: true });
  await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
  assert.deepEqual(f.shares.folders(f.member.assistantId), {
    [f.folderProject.id]: "read",
  });
  const second = await f.task();
  await assert.rejects(write(f, second, "x.md"), code("PROJECT_READ_ONLY"));
  done(f, second);
  // ... and writes on the member's own grant in one that may.
  const third = await f.task(writable);
  assert.equal((await write(f, third, "own.md")).created, true);
  assert.equal(lastFileAudit(f).details.via, "own-grant");
});

test("coding on the member's own project in a lead's task uses its grant and waits for the owner", async (t) => {
  const f = await setup(t);
  // Even where the owner lets the member start pipelines on its own.
  own(f, "read", { autonomous: true });
  const { inv } = await f.task(writable);
  const catalog = await f.call(inv, { action: "catalog" });
  assert.deepEqual(
    catalog.projects.map((p) => [p.id, p.sharedBy]),
    [[f.folderProject.id, undefined]],
  );
  const action = await f.call(inv, {
    action: "coding_start",
    pipelineId: f.pipeline.id,
    task: "Render the site",
  });
  assert.equal(action.state, "awaiting_approval");
  const stored = f.workflows.store.get(action.id);
  assert.equal(stored.inherited, undefined, "the member's own grant, no share");
  assert.equal(stored.leadRequestId !== undefined, true);
  assert.equal(stored.leadAssistantId, f.lead);
  // Project memory stays out of a lead's task.
  await assert.rejects(f.call(inv, { action: "memory_search" }), code("FORBIDDEN"));
});
