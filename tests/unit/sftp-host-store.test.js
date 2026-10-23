import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SshCatalog } from "../../server/features/ssh/ssh-catalog.js";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import {
  adoptProject,
  hostTuple,
  moveProject,
  ownsProjectAccess,
} from "../../server/features/ssh/ssh-management-records.js";
import { remoteRootValue } from "../../server/features/ssh/sftp-host-fields.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { sshKeyPair, startSftpServer } from "../helpers/sftp-server.js";

const hostKey = sshKeyPair().public.split(/\s+/).slice(0, 2).join(" ");

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sftp-hosts-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  const store = new SshAccessStore({ dataDir, catalog });
  const passwords = path.join(dataDir, "ssh", "passwords");
  const stored = () => JSON.parse(fs.readFileSync(catalog.file, "utf8"));
  return { dataDir, catalog, store, passwords, stored };
}

const sftp = (extra = {}) => ({
  name: "Webspace",
  host: "sftp.example.test",
  port: 22,
  username: "deploy",
  hostKey,
  type: "sftp",
  auth: "password",
  password: "pw-secret",
  ...extra,
});

test("creates a password SFTP host", async (t) => {
  const { store, passwords, stored } = fixture(t);
  const host = await store.create(sftp({ remoteRoot: "/public_html/" }));
  assert.equal(host.type, "sftp");
  assert.equal(host.auth, "password");
  assert.equal(host.hasPassword, true);
  assert.equal(host.remoteRoot, "/public_html");
  assert.equal(host.keyId, null);
  assert.equal(host.keyName, null);
  assert.equal(host.publicKey, null);
  assert.equal(host.fingerprint, null);
  assert.ok(!JSON.stringify(store.list()).includes("pw-secret"));
  assert.ok(!JSON.stringify(stored()).includes("pw-secret"));
  const row = stored().sftpHosts[0];
  assert.match(row.credentialRevision, /^[0-9a-f-]{36}$/);
  const file = path.join(passwords, host.id, row.credentialRevision);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.sftpConnection(host.id).password, "pw-secret");
});

test("key SFTP host counts as a key user", async (t) => {
  const { store, stored } = fixture(t);
  const users = { deploy: {} };
  const fixtureServer = await startSftpServer({ users });
  t.after(() => fixtureServer.close());
  const host = await store.create(
    sftp({
      host: fixtureServer.host,
      port: fixtureServer.port,
      hostKey: fixtureServer.hostKey,
      auth: "key",
      password: undefined,
    }),
  );
  assert.equal(host.auth, "key");
  assert.equal(host.hasPassword, false);
  assert.deepEqual(store.keyStore.get(host.keyId).hosts, [
    { id: host.id, name: "Webspace" },
  ]);
  await assert.rejects(store.keyStore.remove(host.keyId), { status: 409 });
  const connection = store.sftpConnection(host.id);
  assert.ok(Buffer.isBuffer(connection.privateKey));
  assert.equal(connection.password, undefined);
  assert.equal(stored().sftpHosts[0].keyId, host.keyId);
  assert.ok(!JSON.stringify(store.list()).includes("PRIVATE KEY"));
  await assert.rejects(store.test(host.id), { status: 502 });
  users.deploy.publicKey = host.publicKey;
  assert.deepEqual(await store.test(host.id), { ok: true });
});

test("password change rotates credentialRevision and revision", async (t) => {
  const { store, passwords, stored } = fixture(t);
  const host = await store.create(sftp());
  const before = stored().sftpHosts[0].credentialRevision;
  const revision = store.revision(host.id);
  await store.update(host.id, { name: "Renamed" });
  assert.equal(stored().sftpHosts[0].credentialRevision, before);
  assert.equal(store.revision(host.id), revision);
  await store.update(host.id, { password: "pw-new" });
  const after = stored().sftpHosts[0].credentialRevision;
  assert.notEqual(after, before);
  assert.notEqual(store.revision(host.id), revision);
  assert.deepEqual(fs.readdirSync(path.join(passwords, host.id)), [after]);
  assert.equal(store.sftpConnection(host.id).password, "pw-new");
  assert.equal(store.sftpConnection(host.id).revision, store.revision(host.id));
  const rooted = store.revision(host.id);
  await store.update(host.id, { remoteRoot: "/www" });
  assert.notEqual(store.revision(host.id), rooted);
  assert.equal(store.get(host.id).remoteRoot, "/www");
  await assert.rejects(store.update(host.id, { auth: "key" }), { status: 400 });
});

test("rollback leaves no password file", async (t) => {
  const { catalog, store, passwords, stored } = fixture(t);
  await assert.rejects(
    catalog.run(async () => {
      await store.create(sftp());
      catalog.beforeCommit(() => {
        throw Error("abort");
      });
    }),
    /abort/,
  );
  assert.deepEqual(stored().sftpHosts ?? [], []);
  assert.deepEqual(fs.existsSync(passwords) ? fs.readdirSync(passwords) : [], []);
  const host = await store.create(sftp());
  const current = stored().sftpHosts[0].credentialRevision;
  await assert.rejects(
    catalog.run(async () => {
      await store.update(host.id, { password: "pw-new" });
      catalog.beforeCommit(() => {
        throw Error("abort");
      });
    }),
    /abort/,
  );
  assert.deepEqual(fs.readdirSync(path.join(passwords, host.id)), [current]);
  assert.equal(store.sftpConnection(host.id).password, "pw-secret");
});

test("remove deletes the password directory after commit", async (t) => {
  const { catalog, store, passwords } = fixture(t);
  const host = await store.create(sftp());
  await assert.rejects(
    catalog.run(async () => {
      await store.remove(host.id);
      catalog.beforeCommit(() => {
        throw Error("abort");
      });
    }),
    /abort/,
  );
  assert.equal(fs.existsSync(path.join(passwords, host.id)), true);
  await store.remove(host.id);
  assert.equal(fs.existsSync(path.join(passwords, host.id)), false);
  assert.throws(() => store.get(host.id), { status: 404 });
});

test("type cannot change", async (t) => {
  const { store } = fixture(t);
  const host = await store.create(sftp());
  await assert.rejects(store.update(host.id, { type: "ssh" }), {
    status: 409,
    message: serverMessages.ssh.hostTypeFixed,
  });
  const ssh = await store.create({
    name: "Shell",
    host: "a.test",
    username: "u",
    hostKey,
  });
  await assert.rejects(store.update(ssh.id, { type: "sftp" }), { status: 409 });
  await assert.rejects(store.update(ssh.id, { password: "x" }), {
    message: serverMessages.ssh.passwordNotAllowed,
  });
  await assert.rejects(store.create(sftp({ password: undefined })), {
    message: serverMessages.ssh.passwordRequired,
  });
  await assert.rejects(store.create(sftp({ auth: "agent" })), {
    message: serverMessages.ssh.invalidAuth,
  });
  await assert.rejects(store.create(sftp({ type: "ftp" })), { status: 400 });
  await assert.rejects(
    store.create({
      name: "Shell",
      host: "a.test",
      username: "u",
      hostKey,
      password: "x",
    }),
    { message: serverMessages.ssh.passwordNotAllowed },
  );
});

test("SSH and SFTP host may share endpoint", async (t) => {
  const { store } = fixture(t);
  const endpoint = { host: "shared.test", port: 22, username: "deploy" };
  const ssh = await store.create({ name: "Shell", hostKey, ...endpoint });
  const host = await store.create(sftp(endpoint));
  assert.notEqual(hostTuple(ssh), hostTuple(host));
  assert.equal(hostTuple(ssh), JSON.stringify(["shared.test", 22, "deploy"]));
  assert.equal(hostTuple(host), JSON.stringify(["shared.test", 22, "deploy", "sftp"]));
  assert.equal(store.list().length, 2);
});

test("connection() refuses SFTP with SSH_HOST_TYPE", async (t) => {
  const { store } = fixture(t);
  const host = await store.create(sftp());
  assert.throws(() => store.connection(host.id), {
    code: "SSH_HOST_TYPE",
    status: 409,
    message: serverMessages.ssh.sftpOnly,
  });
  const ssh = await store.create({
    name: "Shell",
    host: "a.test",
    username: "u",
    hostKey,
  });
  assert.throws(() => store.sftpConnection(ssh.id), { code: "SSH_HOST_TYPE" });
});

test("test() succeeds against the fixture and fails with a wrong password", async (t) => {
  const { store } = fixture(t);
  const server = await startSftpServer();
  t.after(() => server.close());
  const host = await store.create(
    sftp({ host: server.host, port: server.port, hostKey: server.hostKey }),
  );
  assert.deepEqual(await store.test(host.id), { ok: true });
  await store.update(host.id, { remoteRoot: "/missing" });
  await assert.rejects(store.test(host.id), { status: 502 });
  await store.update(host.id, { remoteRoot: null, password: "wrong" });
  await assert.rejects(store.test(host.id), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.message, serverMessages.ssh.connectionFailed);
    assert.ok(!String(error.stack).includes("wrong"));
    return true;
  });
});

test("remoteRoot must be absolute without ..", async (t) => {
  assert.equal(remoteRootValue(undefined), null);
  assert.equal(remoteRootValue(""), null);
  assert.equal(remoteRootValue("/"), "/");
  assert.equal(remoteRootValue("//a//b/./c/"), "/a/b/c");
  for (const bad of [
    "relative",
    "/a/../b",
    "/..",
    "/a\nb",
    "/a\u0007",
    3,
    "/" + "a".repeat(1024),
  ])
    assert.throws(() => remoteRootValue(bad), {
      message: serverMessages.ssh.invalidRemoteRoot,
    });
  const { store } = fixture(t);
  await assert.rejects(store.create(sftp({ remoteRoot: "www" })), { status: 400 });
  await assert.rejects(
    store.create({ name: "S", host: "a.test", username: "u", hostKey, remoteRoot: "/" }),
    { status: 400 },
  );
});

test("SSH rows keep their revision", async (t) => {
  const { store, stored } = fixture(t);
  const ssh = await store.create({
    name: "Shell",
    host: "a.test",
    username: "u",
    hostKey,
  });
  const expected = createHash("sha256")
    .update(JSON.stringify(["a.test", 22, "u", ssh.keyId, hostKey]))
    .digest("hex");
  assert.equal(store.revision(ssh.id), expected);
  const connection = store.connection(ssh.id);
  connection.cleanup();
  assert.equal(connection.revision, expected);
  assert.equal(ssh.type, "ssh");
  assert.equal(ssh.auth, "key");
  assert.equal(ssh.remoteRoot, null);
  assert.equal(ssh.hasPassword, false);
  await store.update(ssh.id, { name: "Renamed" });
  const row = stored().hosts[0];
  for (const field of ["type", "auth", "remoteRoot", "hasPassword", "credentialRevision"])
    assert.equal(field in row, false, field);
});

test("SFTP rows are stored only in sftpHosts", async (t) => {
  const { store, stored } = fixture(t);
  const ssh = await store.create({
    name: "Shell",
    host: "a.test",
    username: "u",
    hostKey,
  });
  const password = await store.create(sftp());
  const key = await store.create(sftp({ auth: "key", password: undefined }));
  const snapshot = stored();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(
    snapshot.hosts.map((row) => row.id),
    [ssh.id],
  );
  assert.deepEqual(
    snapshot.sftpHosts.map((row) => row.id),
    [password.id, key.id],
  );
  assert.ok(snapshot.hosts.every((row) => row.keyId));
  assert.deepEqual(
    store.list().map((row) => row.type),
    ["ssh", "sftp", "sftp"],
  );
});

test("removing a key tombstones receipts of SFTP hosts too", async (t) => {
  const { catalog, store, stored } = fixture(t);
  const host = await store.create(sftp({ auth: "key", password: undefined }));
  await catalog.run(() =>
    catalog.replacePart("receipts", [
      { id: randomUUID(), resourceId: host.id, keyId: host.keyId, accessId: host.id },
      { id: randomUUID(), resourceId: host.keyId, keyId: host.keyId },
    ]),
  );
  await store.remove(host.id);
  assert.deepEqual(
    stored().receipts.map((row) => row.tombstone ?? false),
    [true, false],
  );
  await store.keyStore.remove(host.keyId);
  assert.deepEqual(
    stored().receipts.map((row) => row.tombstone ?? false),
    [true, true],
  );
  assert.deepEqual(stored().sftpHosts, []);
});

test("a malformed sftpHosts part makes the catalog unavailable", async (t) => {
  const { catalog, stored } = fixture(t);
  assert.deepEqual(catalog.read().sftpHosts, []);
  fs.writeFileSync(catalog.file, JSON.stringify({ ...stored(), sftpHosts: {} }));
  assert.throws(() => catalog.read(), { status: 503 });
});

test("project moves and collisions cover sftpHosts", async (t) => {
  const { catalog, store, stored } = fixture(t);
  const project = (id) => ({ id, name: id, cwd: `/work/${id}`, kind: "git" });
  const host = await store.create(sftp({ projectId: "from" }));
  assert.equal(ownsProjectAccess(catalog, "from"), true);
  await catalog.run(() => adoptProject(catalog, "from", project("middle")));
  assert.equal(stored().sftpHosts[0].projectId, "middle");
  await store.create(sftp({ projectId: "target" }));
  await assert.rejects(
    catalog.run(() => moveProject(catalog, "middle", project("target"))),
    { code: "SSH_PROJECT_COLLISION" },
  );
  await store.update(host.id, { username: "other" });
  await catalog.run(() => moveProject(catalog, "middle", project("target")));
  assert.deepEqual(
    stored().sftpHosts.map((row) => row.projectId),
    ["target", "target"],
  );
  assert.equal(stored().hosts.length, 0);
});

test("startup removes password directories without a host", async (t) => {
  const { dataDir, store, passwords } = fixture(t);
  const host = await store.create(sftp());
  const orphan = path.join(passwords, randomUUID());
  fs.mkdirSync(orphan, { mode: 0o700 });
  fs.writeFileSync(path.join(orphan, randomUUID()), "left by a crash", { mode: 0o600 });
  new SshCatalog({ dataDir }).migrate();
  assert.deepEqual(fs.readdirSync(passwords), [host.id]);
  assert.equal(store.sftpConnection(host.id).password, "pw-secret");
});
