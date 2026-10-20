import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { setProjectAgent } from "../../server/features/assistants/project-agent-access.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};
const folderOnly = {
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
};

// The fixture's agent as an agent of a restricted user, with a registered folder.
async function setup(t) {
  const f = await workflowFixture(t);
  const body = { ...f.store.storedAssistant(f.id), userAccess };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "user-folder-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, ".git"));
  fs.writeFileSync(path.join(folder, "README.md"), "# Family\n");
  const project = await f.memory.register(folder);
  f.assistants.config = { writeGuard: () => true };
  const grant = (level) =>
    f.workflows.access.save(
      f.id,
      { ...folderOnly, projectFiles: { [project.id]: level } },
      f.workflows.access.get(f.id).revision,
    );
  const call = async (input) =>
    f.workflows.invoke(await f.invocation(randomUUID()), {
      projectId: project.id,
      ...input,
    });
  return { ...f, folder, folderProject: project, grant, call };
}
const code = (key) => (error) => toolError(error).code === key || error.code === key;

test("a user agent reads an assigned folder and writes only with write access", async (t) => {
  const f = await setup(t);
  const saved = f.grant("read");
  assert.deepEqual(saved.projectIds, []);
  assert.deepEqual(saved.projectFiles, { [f.folderProject.id]: "read" });
  assert.equal(
    (await f.call({ action: "file_read", path: "README.md" })).content,
    "# Family\n",
  );
  await assert.rejects(
    f.call({ action: "file_write", path: "notes.md", content: "x" }),
    code("PROJECT_READ_ONLY"),
  );
  f.grant("write");
  await f.call({ action: "file_write", path: "notes.md", content: "milk" });
  assert.equal(fs.readFileSync(path.join(f.folder, "notes.md"), "utf8"), "milk");
  // Unknown projects are dropped, as for every agent.
  const unknown = f.workflows.access.save(
    f.id,
    { ...folderOnly, projectFiles: { [f.folderProject.id]: "read", gone: "write" } },
    f.workflows.access.get(f.id).revision,
  );
  assert.deepEqual(unknown.projectFiles, { [f.folderProject.id]: "read" });
});

test("a user agent never starts coding", async (t) => {
  const f = await setup(t);
  f.grant("write");
  for (const action of ["coding_start", "memory_search", "memory_write"])
    await assert.rejects(
      f.call({
        action,
        pipelineId: f.pipeline.id,
        task: "Build it",
        title: "Note",
        content: "x",
      }),
      code("USER_AGENT_LOCKED"),
      action,
    );
  assert.deepEqual(f.workflows.list(f.id).actions, []);
  assert.deepEqual(f.starts, []);
});

test("a user agent gets no project memory", async (t) => {
  const f = await setup(t);
  f.grant("read");
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
  const teams = new TeamStore({ store: f.store });
  const services = { assistants: f.assistants, access: f.workflows.access, teams };
  const set = (input) => setProjectAgent(services, f.folderProject.id, f.id, input);
  const read = { coding: false, folder: "read" };
  assert.throws(
    () => set({ expected: read, coding: true, folder: "write" }),
    code("USER_AGENT_LOCKED"),
  );
  const changed = set({ expected: read, coding: false, folder: "write" });
  assert.deepEqual([changed.coding, changed.folder], [false, "write"]);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
});
