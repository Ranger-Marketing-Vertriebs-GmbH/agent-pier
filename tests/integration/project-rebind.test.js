import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { connect } from "../helpers/session-mcp.js";
import { capabilityDirectory } from "../../server/features/mcp/session-capability.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { projectScope } from "../../server/features/memory/project-scope.js";

const gitInit = (cwd, ...args) =>
  execFileSync("git", ["init", "-q", ...args, cwd], { stdio: "ignore" });

/** A running session with AgentPier tools and SSH tools in a disposable folder. */
async function projectSession(
  t,
  f,
  { folder = "plain-project", git = false, selection = true } = {},
) {
  const cwd = path.join(f.home, folder);
  await fs.mkdir(cwd, { recursive: true });
  if (git) gitInit(cwd);
  await fs.writeFile(path.join(cwd, "report.html"), "<h1>Report</h1>");
  const account = f.application.accounts.get("local-codex");
  const id = randomUUID();
  const tooled = await f.application.sessionMcp.prepare({
    id,
    account,
    cwd,
    launch: { args: [], env: {} },
    selection,
  });
  const launch = await f.application.sshIntegration.prepare({
    id,
    account,
    cwd,
    launch: tooled,
  });
  const session = await f.application.sessions.create({
    ...launch,
    id,
    name: "Disposable rebind session",
    tool: "codex",
    accountId: account.id,
    cwd,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  const file = path.join(
    capabilityDirectory(f.dataDir, id),
    `${launch.agentpierTools.generation}.json`,
  );
  const client = await connect(t, f, { file });
  const capability = JSON.parse(await fs.readFile(capabilityFile(f.dataDir, id), "utf8"));
  const publish = (args = {}) =>
    client.callTool({
      name: "artifact_publish",
      arguments: {
        requestId: randomUUID(),
        title: "Report",
        sourcePath: "report.html",
        ...args,
      },
    });
  return {
    cwd,
    session,
    client,
    publish,
    fromId: launch.sshTools.project.projectId,
    ssh: (name, args = {}) => f.application.sshManagement.call(capability, name, args),
    record: () => f.application.sessions.metadata(id),
  };
}
async function projectHost(f, projectId) {
  const management = f.application.sshManagement;
  const key = await management.ui("createKey", { name: "Deploy", projectId });
  const host = await management.ui("createHost", {
    name: "Deploy host",
    host: "host.invalid",
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
    projectId,
  });
  return { key, host };
}
const changedMessage =
  "The project of this session changed. Reload the session to continue.";
const parsed = (result) => JSON.parse(result.content[0].text);
const auditRows = (f, action) =>
  f.application.audit.list({ action }).events.filter((row) => row.action === action);

test("git init in a plain session folder keeps artifact, SSH and memory access", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const { key, host } = await projectHost(f, s.fromId);
  f.application.memory.write(s.fromId, { title: "Note", content: "Kept" });
  const before = await s.publish();
  assert.notEqual(before.isError, true, JSON.stringify(before));
  const original = parsed(before);
  assert.equal(original.projectId, s.fromId);

  gitInit(s.cwd);
  const toId = (await projectScope(s.cwd)).id;
  assert.notEqual(toId, s.fromId);

  const listing = await s.client.callTool({ name: "artifacts_list", arguments: {} });
  assert.notEqual(listing.isError, true, JSON.stringify(listing));
  assert.equal(parsed(listing).items.length, 1);

  const fresh = await s.publish({ title: "After git init" });
  assert.notEqual(fresh.isError, true, JSON.stringify(fresh));
  assert.equal(parsed(fresh).projectId, toId);

  const updated = await s.publish({ title: "Updated", artifactId: original.id });
  assert.notEqual(updated.isError, true, JSON.stringify(updated));
  assert.equal(parsed(updated).id, original.id);
  assert.equal((await f.application.artifacts.get(original.id)).projectId, toId);

  const record = await s.record();
  assert.equal(record.sshTools.project.projectId, toId);
  assert.equal(record.sshTools.project.kind, "git");
  assert.ok((await f.application.sshSessions.effective(record)).includes(host.id));
  assert.equal(f.application.sshAccesses.get(host.id).projectId, toId);
  assert.equal((await s.ssh("ssh_get_public_key", { keyId: key.id })).id, key.id);
  assert.equal((await s.ssh("ssh_list_keys")).total, 1);

  assert.equal(f.application.memory.list(toId).total, 1);
  assert.ok(!f.application.memory.projects().projects.some((p) => p.id === s.fromId));
  assert.equal(auditRows(f, "project.updated").length, 1);
});

test("SSH keeps the launch project after git init and rebinds on management calls", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const { host } = await projectHost(f, s.fromId);
  gitInit(s.cwd);
  const toId = (await projectScope(s.cwd)).id;
  // Out-of-process SSH tools validate the stored binding: the launch project
  // stays usable until the server process rebinds it.
  assert.deepEqual(await f.application.sshSessions.effective(await s.record()), [
    host.id,
  ]);
  assert.equal((await s.ssh("ssh_list_keys")).total, 1);
  const record = await s.record();
  assert.equal(record.sshTools.project.projectId, toId);
  assert.deepEqual(await f.application.sshSessions.effective(record), [host.id]);
  const listing = await s.client.callTool({ name: "artifacts_list", arguments: {} });
  assert.notEqual(listing.isError, true);
  const published = await s.publish();
  assert.equal(parsed(published).projectId, toId);
});

test("a replaced session folder stays strictly rejected with a clear message", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const { host } = await projectHost(f, s.fromId);
  await fs.rename(s.cwd, `${s.cwd}-old`);
  await fs.mkdir(s.cwd);
  await fs.writeFile(path.join(s.cwd, "report.html"), "<h1>Swapped</h1>");
  gitInit(s.cwd);
  const result = await s.publish();
  assert.equal(result.isError, true);
  assert.deepEqual(parsed(result), { error: changedMessage, status: 409 });
  const listing = await s.client.callTool({ name: "artifacts_list", arguments: {} });
  assert.notEqual(listing.isError, true, "Listing is session-scoped");
  await assert.rejects(s.ssh("ssh_list_keys"), { code: "SSH_PROJECT_CHANGED" });
  await assert.rejects(f.application.sshSessions.effective(await s.record()), {
    code: "SSH_PROJECT_CHANGED",
  });
  assert.equal(f.application.sshAccesses.get(host.id).projectId, s.fromId);
  assert.equal((await s.record()).sshTools.project.projectId, s.fromId);
  assert.equal(auditRows(f, "artifact.denied").length, 1);
  assert.equal(auditRows(f, "ssh.denied").length, 1);
  assert.equal(auditRows(f, "project.updated").length, 0);
});

test("removing .git from a session repository stays strict", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f, { git: true });
  await fs.rm(path.join(s.cwd, ".git"), { recursive: true, force: true });
  const result = await s.publish();
  assert.equal(result.isError, true);
  assert.equal(parsed(result).error, changedMessage);
  await assert.rejects(s.ssh("ssh_list_keys"), { code: "SSH_PROJECT_CHANGED" });
});

test("git init never adopts a git identity that already owns project data", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const { host } = await projectHost(f, s.fromId);
  gitInit(s.cwd);
  // Data that predates this session's rebind, as after restoring an older .git.
  const target = await f.application.memory.register(s.cwd);
  f.application.memory.write(target.id, { title: "Foreign", content: "Not adopted" });
  assert.equal(
    await f.application.projectRebind.rebind({ cwd: s.cwd, previousIds: [s.fromId] }),
    null,
  );
  // SSH keeps only the launch project's own access; nothing moves or merges.
  assert.equal((await s.ssh("ssh_list_keys")).total, 1);
  assert.deepEqual(await f.application.sshSessions.effective(await s.record()), [
    host.id,
  ]);
  assert.equal(f.application.sshAccesses.get(host.id).projectId, s.fromId);
  assert.equal((await s.record()).sshTools.project.projectId, s.fromId);
  assert.equal(f.application.memory.list(target.id).total, 1);
  assert.ok(f.application.memory.projects().projects.some((p) => p.id === s.fromId));
  assert.equal(auditRows(f, "project.updated").length, 0);
});

test("a session that never held the plain project cannot trigger its rebind", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  gitInit(s.cwd);
  const rebind = (previousIds) =>
    f.application.projectRebind.rebind({ cwd: s.cwd, previousIds });
  assert.equal(await rebind(["0".repeat(64)]), null);
  assert.equal((await s.record()).sshTools.project.projectId, s.fromId);
  assert.equal((await rebind([s.fromId])).id, (await projectScope(s.cwd)).id);
});

test("git init with a git directory outside the session folder stays strict", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  gitInit(s.cwd, `--separate-git-dir=${path.join(f.home, "elsewhere.git")}`);
  const result = await s.publish();
  assert.equal(parsed(result).error, changedMessage);
  await assert.rejects(s.ssh("ssh_list_keys"), { code: "SSH_PROJECT_CHANGED" });
});

test("a current-project grant follows the project to its rebound identity", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f, {
    selection: {
      scopes: ["catalog:read"],
      currentProject: true,
      projectIds: [],
      accountIds: [],
      connectionIds: [],
    },
  });
  const projects = async () =>
    parsed(await s.client.callTool({ name: "projects_list", arguments: {} })).items;
  assert.deepEqual(
    (await projects()).map((p) => p.id),
    [s.fromId],
  );
  gitInit(s.cwd);
  await s.ssh("ssh_list_keys");
  const toId = (await projectScope(s.cwd)).id;
  assert.deepEqual(await projects(), [{ id: toId, name: "plain-project", kind: "git" }]);
});
