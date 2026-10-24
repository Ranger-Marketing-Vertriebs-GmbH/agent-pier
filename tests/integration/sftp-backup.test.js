import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { decryptCredentials } from "../../server/features/operations/archive.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { SshCatalog } from "../../server/features/ssh/ssh-catalog.js";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import {
  sftpHostsMember,
  sftpHostsOmission,
} from "../../server/features/ssh/sftp-backup.js";
import { archiveText, loadArchive } from "../helpers/backup-archive.js";
import { startSftpServer } from "../helpers/sftp-server.js";

const passphrase = "sftp backup passphrase";
const secret = "pw-secret-7c41e";

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sb-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startSftpServer({ users: { deploy: { password: secret } } });
  t.after(() => server.close());
  const dataDir = path.join(root, "live");
  fs.mkdirSync(dataDir);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const memory = new ProjectMemory({ dataDir });
  const scope = await memory.register(project);
  memory.close();
  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  const store = new SshAccessStore({ dataDir, catalog });
  const endpoint = {
    host: server.host,
    port: server.port,
    username: "deploy",
    hostKey: server.hostKey,
  };
  const ssh = await store.create({ name: "Shell", ...endpoint });
  const sftp = await store.create({
    name: "Webspace",
    ...endpoint,
    type: "sftp",
    auth: "password",
    password: secret,
    projectId: scope.id,
  });
  const keyed = await store.create({
    name: "Keyed",
    ...endpoint,
    username: "other",
    type: "sftp",
    auth: "key",
  });
  return { root, dataDir, server, scope, store, ssh, sftp, keyed };
}

async function restore(root, dataDir, made, options = {}, name = made.backup.id) {
  const target = path.join(root, `restored-${name}`);
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
    ...options,
  });
  return { target, report };
}

/** Starts the SSH catalog of a data folder the way the server does. */
function start(dataDir) {
  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  return { catalog, store: new SshAccessStore({ dataDir, catalog }) };
}

const sealed = (dataDir) =>
  new Backup({ dataDir }).create({
    includeHistory: false,
    withCredentials: true,
    passphrase,
  });

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

test("ordinary backup has no SFTP password anywhere", async (t) => {
  const { dataDir } = await setup(t);
  const made = await new Backup({ dataDir }).create({ includeHistory: false });
  const archive = loadArchive(made.file);
  assert.equal(archive.credentials, undefined);
  const text = archiveText(made.file);
  for (const needle of [secret, "ssh/passwords", sftpHostsMember])
    assert.equal(text.includes(needle), false, needle);
  assert.equal(JSON.stringify(archive.manifest).includes(secret), false);
  assert.equal(
    archive.files.some((member) => member.path.startsWith("ssh/")),
    false,
  );
});

test("ordinary backup lists the SFTP omission", async (t) => {
  const { dataDir } = await setup(t);
  const backup = new Backup({ dataDir });
  assert.ok(backup.plan({}).omissions.includes(sftpHostsOmission));
  assert.equal(backup.plan({}).components.includes("sealed-sftp-hosts"), false);
  const made = await backup.create({ includeHistory: false });
  assert.ok(made.manifest.omissions.includes(sftpHostsOmission));
  const credentialed = backup.plan({ withCredentials: true });
  assert.ok(credentialed.components.includes("sealed-sftp-hosts"));
  assert.equal(credentialed.omissions.includes(sftpHostsOmission), false);
});

test("credential backup seals the SFTP host", async (t) => {
  const { dataDir, sftp, ssh, keyed } = await setup(t);
  const made = await sealed(dataDir);
  const archive = loadArchive(made.file);
  assert.equal(made.manifest.omissions.includes(sftpHostsOmission), false);
  for (const member of archive.files)
    assert.equal(
      Buffer.from(member.content, "base64").toString("latin1").includes(secret),
      false,
      member.path,
    );
  assert.equal(archiveText(made.file).includes(secret), false);
  assert.equal(JSON.stringify(archive.manifest).includes(secret), false);
  const opened = await decryptCredentials(archive.credentials, passphrase);
  const member = opened.find((entry) => entry.path === sftpHostsMember);
  assert.ok(member, opened.map((entry) => entry.path).join(","));
  const value = JSON.parse(Buffer.from(member.content, "base64").toString("utf8"));
  assert.deepEqual(
    value.hosts.map((row) => row.id),
    [sftp.id],
  );
  assert.deepEqual(value.passwords, { [sftp.id]: secret });
  const ids = JSON.stringify(opened);
  for (const left of [ssh.id, keyed.id]) assert.equal(ids.includes(left), false);
});

test("wrong passphrase restores nothing", async (t) => {
  const { root, dataDir } = await setup(t);
  const made = await sealed(dataDir);
  const before = fs.readdirSync(root).sort();
  const target = path.join(root, "restored-wrong");
  await assert.rejects(
    new Restore({ dataDir }).apply({
      archive: made.file,
      targetDataDir: target,
      passphrase: "not the right passphrase",
    }),
    (error) => !error.message.includes(secret),
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  for (const file of walk(path.join(dataDir, "operations/restores")))
    assert.equal(fs.readFileSync(file, "latin1").includes(secret), false, file);
});

test("restore brings the password host back", async (t) => {
  const { root, dataDir, sftp } = await setup(t);
  const made = await sealed(dataDir);
  const { target, report } = await restore(root, dataDir, made, { passphrase });
  assert.deepEqual(report.sftpHosts, { restored: 1, skipped: 1 });
  assert.equal(JSON.stringify(report).includes(secret), false);
  // Only the password store holds the password; the capsule member is gone.
  assert.equal(fs.existsSync(path.join(target, sftpHostsMember)), false);
  const holding = walk(target).filter((file) =>
    fs.readFileSync(file, "latin1").includes(secret),
  );
  assert.equal(holding.length, 1, holding.join(","));
  assert.ok(holding[0].startsWith(path.join(target, "ssh/passwords", sftp.id)));
  assert.equal(fs.statSync(path.join(target, "ssh")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(target, "ssh/passwords")).mode & 0o777, 0o700);
  // Until the first start imports the host, its password directory is still pending.
  assert.ok(fs.existsSync(path.join(target, "ssh/passwords", sftp.id, ".pending")));
  assert.ok(fs.existsSync(path.join(target, "ssh/sftp-restore.json")));
  const { store } = start(target);
  const back = store.list();
  assert.deepEqual(
    back.map((row) => [row.id, row.type, row.auth, row.hasPassword]),
    [[sftp.id, "sftp", "password", true]],
  );
  assert.equal(fs.statSync(holding[0]).mode & 0o777, 0o600);
  // The startup import settled the restored password instead of removing it.
  assert.equal(fs.existsSync(path.join(target, "ssh/sftp-restore.json")), false);
  assert.equal(
    fs.existsSync(path.join(target, "ssh/passwords", sftp.id, ".pending")),
    false,
  );
  assert.deepEqual(await store.test(sftp.id), { ok: true });
  // A second start keeps the host and its password.
  const again = start(target).store;
  assert.equal(again.list().length, 1);
  assert.equal(again.sftpConnection(sftp.id).password, secret);
});

test("restore maps the host's project", async (t) => {
  const { root, dataDir, sftp, scope } = await setup(t);
  const made = await sealed(dataDir);
  const moved = path.join(root, "moved");
  fs.mkdirSync(moved);
  const { target, report } = await restore(root, dataDir, made, {
    passphrase,
    projectMap: { [scope.id]: moved },
  });
  assert.deepEqual(report.sftpHosts, { restored: 1, skipped: 0 });
  const expected = (await projectScope(moved, { known: false })).id;
  assert.notEqual(expected, scope.id);
  assert.equal(start(target).store.get(sftp.id).projectId, expected);
  // Without a mapping the host comes back without a project.
  const { target: unmapped } = await restore(
    root,
    dataDir,
    made,
    { passphrase },
    "unmapped",
  );
  assert.equal(start(unmapped).store.get(sftp.id).projectId, null);
});

test("key SFTP host and SSH host stay omitted", async (t) => {
  const { root, dataDir, ssh, keyed } = await setup(t);
  const made = await sealed(dataDir);
  assert.ok(
    made.manifest.omissions.includes(
      "Managed SSH accesses, private keys and session assignments",
    ),
  );
  const { target } = await restore(root, dataDir, made, { passphrase });
  const ids = start(target)
    .store.list()
    .map((row) => row.id);
  for (const id of [ssh.id, keyed.id]) assert.equal(ids.includes(id), false);
  assert.equal(fs.existsSync(path.join(target, "ssh/keys", keyed.keyId ?? "-")), false);
});

test("restore does not duplicate an existing host", async (t) => {
  const { root, dataDir, sftp } = await setup(t);
  const made = await sealed(dataDir);
  const { target } = await restore(root, dataDir, made, { passphrase });
  const pending = path.join(target, "ssh/sftp-restore.json");
  const copy = fs.readFileSync(pending);
  start(target);
  // An import interrupted after its catalog write runs again on the next start.
  fs.writeFileSync(pending, copy, { mode: 0o600 });
  const { store, catalog } = start(target);
  assert.deepEqual(
    store.list().map((row) => row.id),
    [sftp.id],
  );
  assert.equal(fs.existsSync(pending), false);
  // A host with another id at the same address is not added twice either.
  const restored = JSON.parse(copy);
  restored.hosts[0].id = "00000000-0000-4000-8000-000000000000";
  fs.writeFileSync(pending, JSON.stringify(restored), { mode: 0o600 });
  start(target);
  assert.equal(JSON.parse(fs.readFileSync(catalog.file, "utf8")).sftpHosts.length, 1);
  assert.equal(start(target).store.sftpConnection(sftp.id).password, secret);
});
