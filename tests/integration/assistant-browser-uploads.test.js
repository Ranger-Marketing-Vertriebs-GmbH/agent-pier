import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { BrowserUploads } from "../../server/features/assistants/browser-upload-staging.js";

const code = (key) => (error) => toolError(error).code === key;
const capabilities = (f, id, on) => {
  const agent = f.store.getAssistant(id);
  f.store.updateAssistant(
    id,
    { capabilities: { ...agent.capabilities, memory: false, reminders: false, ...on } },
    agent.revision,
  );
};

// Runtime paths of a disposable data directory, and a staging area below a
// disposable uploads folder in place of OpenClaw's /tmp/openclaw/uploads.
function stagingFor(t, f) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "browser-uploads-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const paths = {
    root: path.join(base, "assistants"),
    tmp: path.join(base, "assistants", "tmp"),
    state: path.join(base, "assistants", "state"),
    workspaces: path.join(base, "assistants", "workspaces"),
  };
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  f.assistants.runtime = { ...f.assistants.runtime, paths };
  const uploadDir = path.join(base, "openclaw", "uploads");
  f.workflows.browserUploads.files = new BrowserUploads({
    tmp: paths.tmp,
    dataRoot: paths.root,
    uploadDir,
  });
  return { base, paths, uploadDir };
}

async function setup(t) {
  const f = await workflowFixture(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-upload-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, "out"));
  fs.writeFileSync(path.join(folder, "out", "episode.mp4"), "episode-bytes");
  const project = await f.memory.register(folder);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const grant = (projectFiles) =>
    f.workflows.access.save(
      f.id,
      { ...f.policy, projectIds: [project.id], projectFiles },
      f.workflows.access.get(f.id).revision,
    );
  const call = async (input) =>
    f.workflows.invoke(await f.invocation(randomUUID()), {
      action: "browser_upload_stage",
      ...input,
    });
  const staging = stagingFor(t, f);
  capabilities(f, f.id, { browser: true });
  return { ...f, folder, folderProject: project, audits, grant, call, ...staging };
}

// The bridge of the tool guard, with every agent's browser profile admitted.
const bridgeFor = (f) => {
  f.assistants.browsers = {
    policy: async () => ({ allow: true, profile: "agent-profile" }),
  };
  const bridge = new TeamBridge({
    assistants: f.assistants,
    generation: () => 1,
    teams: { store: { context: () => ({ kind: "owner" }) } },
  });
  // Open as after start(), without its HTTP server.
  bridge.closed = false;
  return bridge;
};

test("an owner turn stages a file of a folder it may read and the upload is audited", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.call({ projectId: f.folderProject.id, path: "out/episode.mp4" }),
    code("PROJECT_NOT_GRANTED"),
  );
  // Reading is enough: an upload never changes the folder.
  f.grant({ [f.folderProject.id]: "read" });
  const staged = await f.call({
    projectId: f.folderProject.id,
    path: "out/episode.mp4",
    site: "https://studio.youtube.com/channel/x",
  });
  assert.equal(staged.name, "episode.mp4");
  assert.equal(staged.bytes, 13);
  assert.equal(staged.path, "out/episode.mp4");
  assert.equal(staged.projectId, f.folderProject.id);
  assert.ok(staged.uploadPath.startsWith(f.uploadDir + path.sep));
  assert.equal(fs.readFileSync(staged.uploadPath, "utf8"), "episode-bytes");
  const record = f.audits.findLast((e) => e.details?.kind === "browser-upload");
  assert.equal(record.resourceId, f.id);
  assert.equal(record.projectId, f.folderProject.id);
  assert.deepEqual(record.details, {
    kind: "browser-upload",
    browserUpload: "staged",
    filePath: "out/episode.mp4",
    bytes: 13,
    site: "studio.youtube.com",
  });

  // The browser tool guard admits the agent's own staged file and records the upload.
  const bridge = bridgeFor(f);
  const agentId = f.store.getAssistant(f.id).runtimeAgentId;
  const upload = (paths) =>
    bridge.browserPolicy({ agentId, sessionKey: "s", action: "upload", paths });
  assert.deepEqual(await upload([staged.uploadPath]), {
    allow: true,
    profile: "agent-profile",
  });
  assert.equal(
    f.audits.findLast((e) => e.details?.kind === "browser-upload").details.browserUpload,
    "browser",
  );
  // The project file itself, or a path elsewhere, is refused with a clear reason.
  assert.deepEqual(await upload([path.join(f.folder, "out", "episode.mp4")]), {
    allow: false,
    reason: "uploadOutside",
  });
  // An upload without paths, or not naming them, never passes unchecked.
  assert.deepEqual(await bridge.browserPolicy({ agentId, action: " Upload " }), {
    allow: false,
    reason: "uploadNotStaged",
  });
  // Any other browser call is untouched.
  assert.deepEqual(await bridge.browserPolicy({ agentId, action: "snapshot" }), {
    allow: true,
    profile: "agent-profile",
  });
});

test("staging needs the browser, a regular file and the project read rules", async (t) => {
  const f = await setup(t);
  f.grant({ [f.folderProject.id]: "read" });
  fs.mkdirSync(path.join(f.folder, ".git"));
  fs.writeFileSync(path.join(f.folder, ".git", "config"), "token");
  fs.symlinkSync(os.homedir(), path.join(f.folder, "home"));
  const stage = (p) => f.call({ projectId: f.folderProject.id, path: p });
  await assert.rejects(stage(".git/config"), code("PROJECT_PATH_REFUSED"));
  await assert.rejects(stage("home/.zshrc"), code("PROJECT_PATH_REFUSED"));
  await assert.rejects(stage("out"), code("PROJECT_FILE_UNSUITABLE"));
  await assert.rejects(stage("out/missing.mp4"), code("NOT_FOUND"));
  await assert.rejects(
    f.call({ projectId: f.folderProject.id, path: "out/episode.mp4", site: "a b" }),
    code("INVALID_INPUT"),
  );
  capabilities(f, f.id, { browser: false });
  await assert.rejects(stage("out/episode.mp4"), code("BROWSER_NOT_GRANTED"));
  assert.equal(f.audits.filter((e) => e.details?.kind === "browser-upload").length, 0);
});

test("a file of the agent's own workspace is staged, never its guarded entries", async (t) => {
  const f = await setup(t);
  const workspaces = f.assistants.attachments?.config?.workspaces ?? f.paths.workspaces;
  const own = path.join(workspaces, f.id);
  fs.mkdirSync(path.join(own, "renders"), { recursive: true });
  fs.mkdirSync(path.join(own, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(own, "renders", "cut.mp4"), "cut");
  fs.writeFileSync(path.join(own, "attachments", "owner.png"), "private");
  const staged = await f.call({ path: "renders/cut.mp4" });
  assert.equal(staged.workspace, true);
  assert.equal(fs.readFileSync(staged.uploadPath, "utf8"), "cut");
  const record = f.audits.findLast((e) => e.details?.kind === "browser-upload");
  assert.equal(record.details.workspace, true);
  assert.equal(record.projectId, undefined);
  await assert.rejects(
    f.call({ path: "attachments/owner.png" }),
    code("PROJECT_PATH_REFUSED"),
  );
});

test("one agent's staged file never reaches another agent's browser", async (t) => {
  const f = await leadShareFixture(t);
  stagingFor(t, f);
  fs.mkdirSync(path.join(f.folder, "out"));
  fs.writeFileSync(path.join(f.folder, "out", "final.mp4"), "final");
  capabilities(f, f.lead, { browser: true });
  capabilities(f, f.member.assistantId, { browser: true });
  const stage = async (chat) =>
    f.call(await f.turn(chat), {
      action: "browser_upload_stage",
      projectId: f.folderProject.id,
      path: "out/final.mp4",
    });
  // The member holds no folder of its own: refused until its lead shares it.
  await assert.rejects(stage(f.memberChat.id), code("PROJECT_NOT_GRANTED"));
  await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
  const member = await stage(f.memberChat.id);
  const lead = await f.call(await f.leadTurn(), {
    action: "browser_upload_stage",
    projectId: f.folderProject.id,
    path: "out/final.mp4",
  });
  const bridge = bridgeFor(f);
  const runtimeId = (id) => f.store.getAssistant(id).runtimeAgentId;
  const upload = (id, paths) =>
    bridge.browserPolicy({ agentId: runtimeId(id), action: "upload", paths });
  assert.equal((await upload(f.member.assistantId, [member.uploadPath])).allow, true);
  assert.equal((await upload(f.lead, [lead.uploadPath])).allow, true);
  assert.deepEqual(await upload(f.lead, [member.uploadPath]), {
    allow: false,
    reason: "uploadNotStaged",
  });
  assert.deepEqual(await upload(f.member.assistantId, [lead.uploadPath]), {
    allow: false,
    reason: "uploadNotStaged",
  });
  const staged = f.audits.findLast(
    (e) => e.details?.kind === "browser-upload" && e.resourceId === f.member.assistantId,
  );
  assert.equal(staged.projectId, f.folderProject.id);
  // An agent that loses its browser loses its staged files with the next sweep.
  capabilities(f, f.member.assistantId, { browser: false });
  f.workflows.browserUploads.sweep();
  assert.equal(fs.existsSync(member.uploadPath), false);
  assert.equal(fs.existsSync(lead.uploadPath), true);
});
