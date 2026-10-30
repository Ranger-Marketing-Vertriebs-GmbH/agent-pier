import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import { SshTools, sshTools } from "../../server/features/ssh/ssh-tools.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { writePrivate } from "../../server/lib/storage.js";
import { sessionFolder } from "../../server/features/ssh/ssh-session-config.js";
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-tools-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir });
  const launch = await integration.prepare({
    cwd: dataDir,
    id: "one",
    account: { id: "account", tool: "codex" },
    launch: {},
  });
  const session = {
    id: "one",
    accountId: "account",
    tool: "codex",
    status: "running",
    createdAt: "today",
    sshTools: launch.sshTools,
  };
  writePrivate(path.join(dataDir, "sessions", "one.json"), session);
  const capability = JSON.parse(fs.readFileSync(capabilityFile(dataDir, "one")));
  // A local synthetic executable replaces SSH, so tests never reach a remote host.
  const store = {
    list: () => [
      { id: "host", name: "Synthetic", host: "example.invalid", privateKey: "SECRET" },
      { id: "other", host: "other.invalid" },
    ],
    get: (id) => ({ id }),
    connection: () => ({ command: process.execPath, args: ["-e"], cwd: dataDir }),
  };
  const grants = new SshSessions({ dataDir, store });
  await grants.set(session, ["host"]);
  return {
    tools: new SshTools({ dataDir, capability, grants, store }),
    grants,
    session,
    dataDir,
  };
}
test("SSH tools only list assigned host metadata", async (t) => {
  const { tools, grants, session } = await fixture(t);
  const hosts = await tools.call("ssh_list_hosts", {});
  assert.equal(hosts.hosts.length, 1);
  assert.equal(JSON.stringify(hosts).includes("SECRET"), false);
  await grants.set(session, []);
  assert.deepEqual((await tools.call("ssh_list_hosts", {})).hosts, []);
});

test("coding sessions have no remote-command tool", async (t) => {
  const names = sshTools.map((tool) => tool.name);
  assert.equal(names.includes("ssh_execute"), false);
  for (const tool of sshTools) assert.doesNotMatch(tool.description, /ssh_execute/);
  const { tools } = await fixture(t);
  await assert.rejects(
    tools.call("ssh_execute", { accessId: "host", command: "true" }),
    /Unknown SSH tool/,
  );
});

test("host discovery excludes explicit grants revoked during project validation", async (t) => {
  const { tools, grants, session } = await fixture(t);
  const inherited = grants.inherited.bind(grants);
  grants.inherited = async (...args) => {
    const ids = await inherited(...args);
    grants.discard(session.id);
    return ids;
  };
  assert.deepEqual((await tools.call("ssh_list_hosts", {})).hosts, []);
});

test("host discovery excludes project hosts reassigned during validation", async (t) => {
  const { tools, grants, session } = await fixture(t);
  grants.discard(session.id);
  const hosts = tools.store.list();
  hosts[0].projectId = session.sshTools.project.projectId;
  tools.store.list = () => hosts;
  const inherited = grants.inherited.bind(grants);
  grants.inherited = async (...args) => {
    const ids = await inherited(...args);
    hosts[0].projectId = "other-project";
    return ids;
  };
  assert.deepEqual((await tools.call("ssh_list_hosts", {})).hosts, []);
});

test("ssh-tools lists sftp tools with closed schemas", () => {
  const names = sshTools.map((tool) => tool.name);
  for (const name of [
    "sftp_list",
    "sftp_stat",
    "sftp_download",
    "sftp_upload",
    "sftp_sync",
    "sftp_mkdir",
    "sftp_rename",
    "sftp_delete",
    "sftp_job",
  ])
    assert.ok(names.includes(name), name);
  assert.equal(names.includes("sftp_record"), false);
  for (const tool of sshTools.filter(({ name }) => name.startsWith("sftp_"))) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    if (tool.name !== "sftp_job")
      assert.ok(tool.inputSchema.required.includes("accessId"), tool.name);
  }
  const sync = sshTools.find(({ name }) => name === "sftp_sync").inputSchema;
  assert.deepEqual(sync.properties.direction.enum, ["up", "down"]);
  assert.equal(sync.properties.exclude.maxItems, 50);
  assert.equal(sync.properties.exclude.items.maxLength, 200);
  assert.equal(sync.properties.remotePath.maxLength, 4096);
});

test("ssh_list_hosts reports the host type and keeps SSH hosts typed ssh", async (t) => {
  const { tools } = await fixture(t);
  const [host] = (await tools.call("ssh_list_hosts", {})).hosts;
  assert.equal(host.type, "ssh");
  assert.equal(host.remoteRoot, null);
});

test("sftp tools refuse an SSH host before connecting", async (t) => {
  const { tools } = await fixture(t);
  await assert.rejects(tools.call("sftp_list", { accessId: "host" }), {
    code: "SSH_HOST_TYPE",
  });
});

test("ssh_list_hosts returns the alias from the session's aliases.json", async (t) => {
  const { tools, grants, session, dataDir } = await fixture(t);
  const hosts = [
    ...tools.store.list(),
    { id: "files", name: "Files", host: "files.invalid", type: "sftp" },
  ];
  tools.store.list = () => hosts;
  await grants.set(session, ["host", "files"]);
  const listed = async () => (await tools.call("ssh_list_hosts", {})).hosts;
  // Without an agent folder no host has an alias.
  assert.deepEqual(
    (await listed()).map((host) => host.alias),
    [undefined, undefined],
  );
  const folder = sessionFolder(dataDir, session.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "aliases.json"),
    JSON.stringify({ host: "proxmox-2", files: "files", other: "other" }),
  );
  const result = await listed();
  assert.equal(result.find((host) => host.accessId === "host").alias, "proxmox-2");
  assert.deepEqual(result.find((host) => host.accessId === "host").use, {
    via: "ssh",
    command: "ssh proxmox-2",
  });
  // A row without auth "key" is not a native SFTP host: no alias, sftp_* tools.
  assert.equal(result.find((host) => host.accessId === "files").alias, undefined);
  assert.deepEqual(result.find((host) => host.accessId === "files").use, {
    via: "sftp_tools",
  });
  assert.equal(result.length, 2);
});

test("ssh_list_hosts says per host which way applies", async (t) => {
  const { tools, grants, session, dataDir } = await fixture(t);
  const sftp = { type: "sftp", host: "files.invalid" };
  const hosts = [
    ...tools.store.list(),
    { id: "device", name: "Switch", host: "switch.invalid", interactiveShell: true },
    { id: "keyfiles", name: "Key files", ...sftp, auth: "key", remoteRoot: null },
    { id: "pwfiles", name: "Password files", ...sftp, auth: "password" },
    { id: "rooted", name: "Rooted", ...sftp, auth: "key", remoteRoot: "/www" },
    { id: "plain", name: "Plain", host: "plain.invalid" },
  ];
  tools.store.list = () => hosts;
  await grants.set(session, ["host", "device", "keyfiles", "pwfiles", "rooted", "plain"]);
  const folder = sessionFolder(dataDir, session.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "aliases.json"),
    JSON.stringify({ host: "synthetic", keyfiles: "key-files" }),
  );
  const byId = Object.fromEntries(
    (await tools.call("ssh_list_hosts", {})).hosts.map((host) => [host.accessId, host]),
  );
  assert.deepEqual(byId.host.use, { via: "ssh", command: "ssh synthetic" });
  assert.equal(byId.keyfiles.alias, "key-files");
  assert.deepEqual(byId.keyfiles.use, { via: "sftp", command: "sftp key-files" });
  assert.deepEqual(byId.pwfiles.use, { via: "sftp_tools" });
  assert.deepEqual(byId.rooted.use, { via: "sftp_tools" });
  assert.equal(byId.device.use.via, "helper");
  assert.match(
    byId.device.use.command,
    /'--session' 'one' '--access' 'device' -- <remote command>$/,
  );
  assert.equal(byId.device.alias, undefined);
  // An SSH host without an alias (no agent yet) says so instead of guessing.
  assert.equal(byId.plain.use.via, "unavailable");
  assert.equal(byId.plain.alias, undefined);
});

test("ssh_list_hosts says that SSH hosts carry their alias", () => {
  const tool = sshTools.find(({ name }) => name === "ssh_list_hosts");
  assert.match(tool.description, /alias/);
});
