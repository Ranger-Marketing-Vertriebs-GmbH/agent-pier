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
import { userAgentLocked } from "../../server/features/users/user-agent-lock.js";

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
  const call = async (input, origin) =>
    f.workflows.invoke(await f.invocation(randomUUID(), origin), {
      projectId: project.id,
      ...input,
    });
  return { ...f, folder, folderProject: project, grant, call };
}
// The code the agent's tool call answers, never the raw problem's own field.
const code = (key) => (error) => toolError(error).code === key;

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

test("a user agent never writes configuration the owner's tools run", async (t) => {
  const f = await setup(t);
  f.grant("write");
  const config = [
    ".claude/settings.json",
    ".mcp.json",
    ".envrc",
    ".vscode/tasks.json",
    "opencode.json",
    ".opencode/plugin/x.js",
    "AGENTS.md",
    "CLAUDE.md",
    "lefthook.yaml",
  ];
  for (const at of config)
    await assert.rejects(
      f.call({ action: "file_write", path: at, content: "{}" }),
      code("PROJECT_TOOL_CONFIG_LOCKED"),
      at,
    );
  for (const at of config.map((name) => name.split("/")[0]))
    assert.equal(fs.existsSync(path.join(f.folder, at)), false, at);
  // Her own turn is held to the same lock.
  await assert.rejects(
    f.call(
      { action: "file_write", path: ".claude/settings.json", content: "{}" },
      { kind: "user", userId: "u1" },
    ),
    code("PROJECT_TOOL_CONFIG_LOCKED"),
  );
  await f.call({ action: "file_write", path: "notes.md", content: "milk" });
});

test("a locked capability tells the model not to retry, not to reread and retry", () => {
  const answer = toolError(userAgentLocked());
  assert.equal(answer.status, 409);
  assert.equal(answer.code, "USER_AGENT_LOCKED");
  assert.match(answer.reason, /Do not retry/);
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

test("a user agent's folder changes are audited", async (t) => {
  const f = await setup(t);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const p = f.folderProject.id;
  const folderChanges = () =>
    audits
      .filter((e) => e.details?.kind === "project-grants")
      .map((e) => [e.resourceId, e.details.folderChanged]);
  f.grant("read");
  const teams = new TeamStore({ store: f.store });
  const services = { assistants: f.assistants, access: f.workflows.access, teams };
  const set = (input) => setProjectAgent(services, p, f.id, input);
  set({ expected: { coding: false, folder: "read" }, coding: false, folder: "write" });
  set({ expected: { coding: false, folder: "write" }, coding: false, folder: "none" });
  assert.deepEqual(folderChanges(), [
    [f.id, [{ projectId: p, from: "none", to: "read" }]],
    [f.id, [{ projectId: p, from: "read", to: "write" }]],
    [f.id, [{ projectId: p, from: "write", to: "none" }]],
  ]);
});

test("a user's own turn uses her agent's folders; other users' turns are refused", async (t) => {
  const f = await setup(t);
  f.grant("write");
  const own = { kind: "user", userId: "u1" };
  assert.equal(
    (await f.call({ action: "file_read", path: "README.md" }, own)).content,
    "# Family\n",
  );
  await f.call({ action: "file_write", path: "list.md", content: "eggs" }, own);
  assert.equal(fs.readFileSync(path.join(f.folder, "list.md"), "utf8"), "eggs");
  await assert.rejects(
    f.call({ action: "coding_start" }, own),
    code("USER_AGENT_LOCKED"),
  );
  for (const origin of [
    { kind: "user", userId: "u2" },
    { kind: "user", userId: "u1", forwarded: true },
  ])
    await assert.rejects(f.call({ action: "file_read", path: "README.md" }, origin), {
      status: 403,
    });
});

test("a project rebind drops and audits a user agent's folder-only level", async (t) => {
  const f = await setup(t);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const p = f.folderProject.id;
  f.grant("write");
  assert.equal(f.workflows.holdsProject(p), true);
  f.workflows.revokeProject(p, f.project.id);
  const after = f.workflows.access.get(f.id);
  assert.deepEqual([after.projectIds, after.projectFiles], [[], {}]);
  assert.equal(f.workflows.holdsProject(p), false);
  const rebinds = audits.filter((e) => e.details?.kind === "project-rebind");
  assert.deepEqual(
    rebinds.map((e) => [e.resourceId, e.projectId, e.details.fromProjectId]),
    [[f.id, f.project.id, p]],
  );
  // The old id coming back does not bring the level back.
  assert.deepEqual(f.workflows.access.get(f.id).projectFiles, {});
  await assert.rejects(f.call({ action: "file_read", path: "README.md" }), {
    status: 403,
  });
});
