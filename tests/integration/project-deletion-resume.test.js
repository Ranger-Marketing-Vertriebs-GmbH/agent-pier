import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { deletionScope } from "../../server/application/project-deletion-scope.js";

const timeout = 60000;

// The record start() writes, built from the scope by hand.
async function mark(a, folder) {
  const scope = await deletionScope(a, folder);
  return a.memory.deletions.mark(scope.path, {
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

async function doomed(f) {
  const folder = path.join(f.root, "doomed");
  fs.mkdirSync(folder);
  const project = await f.application.memory.register(folder);
  f.application.memory.write(project.id, { title: "Note", content: "Doomed knowledge" });
  return { folder, id: project.id };
}

for (const [agents, options] of [
  ["off", {}],
  ["on", enabledAssistants],
])
  test(
    `a deletion interrupted after the folder step finishes at the next start (agents ${agents})`,
    { timeout },
    async (t) => {
      const f = await applicationFixture(t, options);
      const { folder, id } = await doomed(f);
      await mark(f.application, folder);
      fs.rmSync(folder, { recursive: true });
      await f.restart();
      assert.equal(f.application.memory.deletions.get(folder), null);
      assert.equal(f.application.memory.hasProject(id), false);
      const events = f.application.audit.list({ action: "project.deleted" }).events;
      assert.equal(events.length, 1);
      assert.equal(events[0].details.path, folder);
      assert.equal(events[0].projectId, id);
    },
  );

test(
  "resume marks a deletion failed when a session runs again in the folder",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t);
    const { folder, id } = await doomed(f);
    await f.application.sessions.create({
      id: "doomed-session",
      name: "Doomed",
      tool: "claude",
      accountId: "fixture",
      cwd: folder,
      command: "/bin/cat",
      args: [],
      env: { PATH: "/usr/bin:/bin", HOME: f.home },
    });
    await mark(f.application, folder);
    await f.restart();
    const record = f.application.memory.deletions.get(folder);
    assert.equal(record.state, "failed");
    assert.equal(record.error, "PROJECT_DELETE_BLOCKED");
    assert.equal(fs.existsSync(folder), true);
    assert.equal(f.application.memory.hasProject(id), true);
  },
);
