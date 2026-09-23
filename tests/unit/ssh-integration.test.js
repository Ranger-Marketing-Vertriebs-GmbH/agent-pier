import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pidStart } from "../../vendor/agentbus/core/proc.js";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import {
  authorizeSsh,
  capabilityFile,
} from "../../server/features/ssh/ssh-capability.js";
import { sshManagementSocket } from "../../server/features/ssh/ssh-management-client.js";
import { writePrivate } from "../../server/lib/storage.js";

for (const tool of ["codex", "claude", "opencode"]) {
  test(`scoped SSH launch for ${tool} rotates and requires live initialization`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const integration = new SshIntegration({ dataDir });
    const input = {
      id: "session-one",
      account: { id: "account", tool },
      cwd: dataDir,
      launch: { command: tool, args: [], env: {} },
    };
    const launch = await integration.prepare(input);
    assert.equal(launch.sshTools.enabled, true);
    assert.equal(launch.sshTools.project.cwd, fs.realpathSync(dataDir));
    const session = {
      id: input.id,
      accountId: "account",
      tool,
      status: "running",
      sshTools: launch.sshTools,
    };
    writePrivate(path.join(dataDir, "sessions", `${session.id}.json`), session);
    const capability = JSON.parse(
      fs.readFileSync(capabilityFile(dataDir, session.id), "utf8"),
    );
    assert.equal(authorizeSsh(dataDir, capability).id, session.id);
    assert.throws(() => authorizeSsh(dataDir, { ...capability, sessionId: "other" }));
    assert.equal(integration.status(session).state, "starting");
    writePrivate(
      path.join(path.dirname(capabilityFile(dataDir, session.id)), "ready.json"),
      {
        generation: launch.sshTools.generation,
        pid: process.pid,
        pidStart: pidStart(process.pid),
        parentPid: process.ppid,
        parentStart: pidStart(process.ppid),
      },
    );
    assert.equal(integration.status(session).state, "ready");
    const readyFile = path.join(
      path.dirname(capabilityFile(dataDir, session.id)),
      "ready.json",
    );
    const ready = JSON.parse(fs.readFileSync(readyFile));
    writePrivate(readyFile, { ...ready, pidStart: "reused" });
    assert.equal(integration.status(session).ready, false);
    if (tool === "codex")
      assert.match(launch.args.join(" "), /mcp_servers.agentpier_ssh=/);
    if (tool === "claude") assert.ok(launch.args.includes("--plugin-dir"));
    if (tool === "opencode")
      assert.ok(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).mcp.agentpier_ssh.enabled);
    const second = await integration.prepare(input);
    assert.notEqual(second.sshTools.generation, launch.sshTools.generation);
    assert.throws(() => authorizeSsh(dataDir, capability));
    integration.discard(session.id);
    assert.equal(integration.status(session).state, "reload-required");
  });
}
test("SSH skips login and headless sessions", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir });
  const launch = { args: [] };
  for (const extra of [{ purpose: "login" }, { pipeline: { headless: true } }])
    assert.equal(await integration.prepare({ launch, ...extra }), launch);
});

test("shell binds project independently without model tools or hints", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-shell-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const launch = { args: [], env: {} };
  const result = await new SshIntegration({ dataDir }).prepare({
    account: { tool: "shell" },
    cwd: dataDir,
    launch,
  });
  assert.equal(result.sshTools.enabled, false);
  assert.equal(result.sshTools.project.cwd, fs.realpathSync(dataDir));
  assert.deepEqual(result.args, []);
  assert.deepEqual(result.env, {});
});

for (const tool of ["shell", "codex", "claude", "opencode"]) {
  test(`${tool} registers project before issuing credentials and propagates registration failures`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-registration-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const input = {
      id: "registered",
      account: { id: "account", tool },
      cwd: dataDir,
      launch: { args: [], env: {} },
    };
    const file = capabilityFile(dataDir, input.id);
    let seen;
    const integration = new SshIntegration({
      dataDir,
      onProject: async (binding) => {
        assert.equal(fs.existsSync(file), false);
        await Promise.resolve();
        seen = binding;
      },
    });
    const result = await integration.prepare(input);
    assert.deepEqual(seen, result.sshTools.project);
    assert.ok(seen?.projectId);
    integration.discard(input.id);
    const failure = new Error("registration unavailable");
    const failing = new SshIntegration({
      dataDir,
      onProject: async () => {
        throw failure;
      },
    });
    await assert.rejects(failing.prepare(input), (error) => error === failure);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(input.launch, { args: [], env: {} });
  });
}
test("a sandboxed session that can reach no host gets neither the SSH tools nor their grants", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-sandbox-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir, accesses: { list: () => [] } });
  const launch = { command: "codex", args: [], env: {} };
  const prepared = await integration.prepare({
    id: "sandboxed-none",
    account: { id: "account", tool: "codex" },
    cwd: dataDir,
    launch,
    sandboxProfile: "codex-default",
    sshAccessIds: [],
  });
  // The store grant cannot be narrowed while the MCP server still starts, so a
  // session that can reach no host is not given the tools at all.
  assert.deepEqual(prepared, launch);
  assert.equal(prepared.sshTools, undefined);
  assert.equal(prepared.sandboxGrants, undefined);
  assert.equal(fs.existsSync(path.join(dataDir, "ssh", "capabilities")), false);
});

test("a sandboxed session with an assigned host grants the SSH store and the session records", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-sandbox-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir, accesses: { list: () => [] } });
  const prepared = await integration.prepare({
    id: "sandboxed-assigned",
    account: { id: "account", tool: "codex" },
    cwd: dataDir,
    launch: { command: "codex", args: [], env: {} },
    sandboxProfile: "codex-default",
    sshAccessIds: ["access-one"],
  });
  assert.equal(prepared.sshTools.enabled, true);
  const granted = prepared.sandboxGrants.map((grant) => grant.path);
  assert.ok(granted.includes(path.join(dataDir, "ssh")));
  assert.ok(granted.includes(path.join(dataDir, "sessions")));
  // Every management tool the session can call travels over this socket.
  assert.ok(granted.includes(sshManagementSocket(dataDir)));
});

test("a sandboxed session inheriting a project host grants the SSH store", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-inherited-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let projectId;
  const integration = new SshIntegration({
    dataDir,
    accesses: { list: () => [{ id: "access-two", projectId }] },
    onProject: (binding) => {
      projectId = binding.projectId;
    },
  });
  // Nothing is assigned to the session: the host belongs to the project the
  // working directory resolves to, which is what `SshSessions.inherited` reads.
  const prepared = await integration.prepare({
    id: "sandboxed-inherited",
    account: { id: "account", tool: "codex" },
    cwd: dataDir,
    launch: { command: "codex", args: [], env: {} },
    sandboxProfile: "codex-default",
    sshAccessIds: [],
  });
  const granted = prepared.sandboxGrants.map((grant) => grant.path);
  assert.ok(granted.includes(path.join(dataDir, "ssh")));
});

test("an unsandboxed session keeps the SSH tools without an assignment", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-integration-open-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir });
  const prepared = await integration.prepare({
    id: "unsandboxed-none",
    account: { id: "account", tool: "codex" },
    cwd: dataDir,
    launch: { command: "codex", args: [], env: {} },
    sshAccessIds: [],
  });
  // Assigning a host to a running unsandboxed session still works, so its MCP
  // server is registered up front as before.
  assert.equal(prepared.sshTools.enabled, true);
});
