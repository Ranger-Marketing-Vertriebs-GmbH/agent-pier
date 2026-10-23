import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshCatalog } from "../../server/features/ssh/ssh-catalog.js";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { LegacySshAccessStore } from "../fixtures/legacy-ssh-catalog-reader.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { sshKeyPair } from "../helpers/sftp-server.js";

const hostKey = sshKeyPair().public.split(/\s+/).slice(0, 2).join(" ");

// A catalog written by this release: one SSH host, a password and a key SFTP host.
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sftp-rollback-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  const store = new SshAccessStore({ dataDir, catalog });
  const endpoint = { host: "web.test", port: 22, username: "deploy", hostKey };
  const ssh = await store.create({ name: "Shell", ...endpoint });
  const password = await store.create({
    name: "Webspace",
    ...endpoint,
    type: "sftp",
    auth: "password",
    password: "pw-secret",
  });
  const key = await store.create({
    name: "Deploy",
    ...endpoint,
    type: "sftp",
    auth: "key",
    keyId: ssh.keyId,
  });
  return { dataDir, catalog, store, ssh, password, key };
}

test("legacy reader loads the catalog", async (t) => {
  const { dataDir, ssh } = await fixture(t);
  const legacy = new LegacySshAccessStore({ dataDir });
  assert.doesNotThrow(() => legacy.catalog.read());
  const hosts = legacy.list();
  assert.deepEqual(
    hosts.map((row) => row.id),
    [ssh.id],
  );
  assert.equal(hosts[0].keyName, ssh.keyName);
});

test("legacy write keeps sftpHosts", async (t) => {
  const { dataDir, catalog, ssh, password, key } = await fixture(t);
  const legacy = new LegacySshAccessStore({ dataDir });
  legacy.rename(ssh.id, "Renamed by an older release");
  const store = new SshAccessStore({ dataDir, catalog });
  assert.deepEqual(
    store.list().map((row) => [row.id, row.name, row.type]),
    [
      [ssh.id, "Renamed by an older release", "ssh"],
      [password.id, "Webspace", "sftp"],
      [key.id, "Deploy", "sftp"],
    ],
  );
  assert.equal(store.sftpConnection(password.id).password, "pw-secret");
  assert.ok(Buffer.isBuffer(store.sftpConnection(key.id).privateKey));
});

// Residual of a rollback: an older release does not see SFTP users of a key, so it
// would allow deleting a key an SFTP host still uses (that host then fails to connect).
test("legacy key list ignores SFTP users", async (t) => {
  const { dataDir, store, ssh, key } = await fixture(t);
  const legacy = new LegacySshAccessStore({ dataDir });
  assert.deepEqual(
    legacy.keyStore.get(ssh.keyId).hosts.map((row) => row.id),
    [ssh.id],
  );
  assert.deepEqual(
    store.keyStore.get(ssh.keyId).hosts.map((row) => row.id),
    [ssh.id, key.id],
  );
});

test("a key deleted by an older release leaves the host list working", async (t) => {
  const { dataDir, catalog, store, ssh, password } = await fixture(t);
  const own = await store.keyStore.create({ name: "SFTP only" });
  const key = await store.create({
    name: "Orphaned",
    host: "web.test",
    username: "other",
    hostKey,
    type: "sftp",
    auth: "key",
    keyId: own.id,
  });
  new LegacySshAccessStore({ dataDir }).removeKey(own.id);
  const current = new SshAccessStore({ dataDir, catalog });
  const listed = current.list();
  assert.equal(listed.length, 4);
  const orphan = listed.find((row) => row.id === key.id);
  assert.equal(orphan.keyMissing, true);
  assert.equal(orphan.keyId, own.id);
  for (const field of ["keyName", "publicKey", "fingerprint"])
    assert.equal(orphan[field], null, field);
  assert.deepEqual(
    listed.filter((row) => row.keyMissing).map((row) => row.id),
    [key.id],
  );
  assert.equal(current.get(ssh.id).keyName, ssh.keyName);
  assert.equal(current.sftpConnection(password.id).password, "pw-secret");
  assert.throws(() => current.sftpConnection(key.id), {
    status: 409,
    message: serverMessages.ssh.keyNotFound,
  });
  await assert.rejects(current.test(key.id), {
    status: 409,
    message: serverMessages.ssh.keyNotFound,
  });
});
