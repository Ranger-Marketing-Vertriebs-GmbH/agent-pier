import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "../helpers/application.js";
import { deletionScope } from "../../server/application/project-deletion-scope.js";
import { setProjectAgent } from "../../server/features/assistants/project-agent-access.js";

const timeout = 60000;
const deleting = { status: 409, code: "PROJECT_DELETING" };
const notDeleting = (error) => error.code !== "PROJECT_DELETING";

async function markDeleting(a, folder) {
  const scope = await deletionScope(a, folder);
  a.memory.deletions.mark(scope.path, {
    name: scope.name,
    folderMissing: false,
    dev: scope.dev,
    ino: scope.ino,
    projectIds: scope.projectIds,
    repositoryIds: scope.repositoryIds,
    busIds: scope.busIds,
    sessionIds: scope.sessionIds,
    runIds: scope.runIds,
    rebuildIds: scope.rebuildIds,
    nested: [],
    report: {
      unsavedGitWork: false,
      nestedProjectIds: [],
      endedSessionIds: [],
      endedProcesses: [],
    },
  });
}

async function projectIn(f, name) {
  const folder = path.join(f.root, name);
  fs.mkdirSync(folder);
  execFileSync("git", ["init", "-q"], { cwd: folder });
  const project = await f.application.memory.register(folder);
  return { folder, id: project.id };
}

test("every start path refuses a folder being deleted", { timeout }, async (t) => {
  const f = await applicationFixture(t);
  const a = f.application;
  const { folder, id } = await projectIn(f, "doomed");
  await markDeleting(a, folder);

  const launch = await f.request("/api/sessions", {
    method: "POST",
    body: { cwd: folder, accountId: "local-codex" },
  });
  assert.equal(launch.status, 409);
  assert.equal((await launch.json()).code, "PROJECT_DELETING");
  // A folder inside it is covered as well.
  await assert.rejects(a.launch({ cwd: path.join(folder, "sub") }), deleting);

  await assert.rejects(
    a.pipelines.start({ pipelineId: "x", cwd: folder, task: "x" }),
    deleting,
  );
  assert.throws(() => a.pipelineQueue.add(id, { pipelineId: "x", task: "x" }), deleting);

  await assert.rejects(
    a.ticketWorktrees.createSession({
      projectPath: folder,
      ticket: { id: "T-1", title: "t" },
      name: "t",
    }),
    deleting,
  );
  assert.equal(fs.existsSync(path.join(folder, ".worktrees")), false);

  // A preview of a session working in the folder.
  a.previews.sessionAlive = () => true;
  await assert.rejects(
    a.previews.open({
      owner: { kind: "session", sessionId: "s1", project: folder },
      port: 9,
    }),
    deleting,
  );

  // An agent grant for the project.
  const services = {
    deletionGuard: a.deletionGuard,
    access: { eligible: () => ({}), s: { memory: { project() {} } } },
  };
  assert.throws(
    () =>
      setProjectAgent(services, id, "agent", {
        expected: { coding: false, folder: "none" },
        coding: true,
        folder: "none",
      }),
    deleting,
  );
});

test("a folder outside the deletion still starts", { timeout }, async (t) => {
  const f = await applicationFixture(t);
  const a = f.application;
  const { folder } = await projectIn(f, "doomed");
  const other = await projectIn(f, "doomed-not");
  await markDeleting(a, folder);
  assert.equal(a.deletionGuard.covers(other.folder), false);
  // Past the guard the unknown pipeline is what gets refused.
  await assert.rejects(
    a.pipelines.start({ pipelineId: "missing", cwd: other.folder, task: "x" }),
    notDeleting,
  );
  assert.throws(
    () => a.pipelineQueue.add(other.id, { pipelineId: "missing", task: "x" }),
    notDeleting,
  );
});
