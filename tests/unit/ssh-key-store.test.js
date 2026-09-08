import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { runOpenSsh } from "../../server/features/ssh/ssh-keys.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-key-catalog-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, "fixture");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
  const privateKey = fs.readFileSync(file, "utf8");
  const publicKey = fs
    .readFileSync(`${file}.pub`, "utf8")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const input = {
    name: "Host",
    host: "example.test",
    username: "deploy",
    hostKey: publicKey,
  };
  return {
    dataDir,
    privateKey,
    publicKey,
    input,
    store: new SshAccessStore({ dataDir, ...options }),
  };
}

test("named keys are reusable, renamed across hosts, retained after host deletion and removable only unused", async (t) => {
  const { store, input, privateKey, dataDir } = fixture(t);
  assert.ok(store.keyStore, "host store exposes the reusable key catalog");
  const key = await store.keyStore.create({
    name: "Deployment",
    privateKey: privateKey.trimEnd(),
  });
  assert.deepEqual(key.hosts, []);
  assert.equal(JSON.stringify(key).includes("PRIVATE KEY"), false);
  const first = await store.create({ ...input, keyId: key.id });
  const second = await store.create({ ...input, name: "Second", keyId: key.id });
  assert.equal(first.fingerprint, second.fingerprint);
  const identity = (id) => {
    const c = store.connection(id);
    return path.resolve(c.cwd, c.args[c.args.indexOf("-i") + 1]);
  };
  assert.equal(identity(first.id), identity(second.id));
  assert.throws(() => store.keyStore.remove(key.id), { status: 409 });
  assert.equal(store.keyStore.rename(key.id, { name: "Renamed" }).name, "Renamed");
  assert.equal(store.get(first.id).keyName, "Renamed");
  assert.equal(store.get(second.id).keyName, "Renamed");
  assert.deepEqual(store.keyStore.get(key.id).hosts, [
    { id: first.id, name: first.name },
    { id: second.id, name: second.name },
  ]);
  const other = await store.keyStore.create({ name: "Replacement" });
  await store.update(second.id, { keyId: other.id });
  assert.equal(store.get(second.id).fingerprint, other.fingerprint);
  const file = identity(first.id);
  store.remove(first.id);
  assert.equal(fs.existsSync(file), true);
  const restarted = new SshAccessStore({ dataDir });
  assert.equal(restarted.keyStore.get(key.id).name, "Renamed");
  restarted.keyStore.remove(key.id);
  assert.equal(fs.existsSync(file), false);
});

test("key and host validation reject ambiguous credentials and invalid references", async (t) => {
  const { store, input, privateKey } = fixture(t);
  assert.ok(store.keyStore);
  const key = await store.keyStore.create({ name: "Key" });
  const host = await store.create({ ...input, keyId: key.id });
  for (const keyId of [null, 22, "../bad", randomUUID()]) {
    await assert.rejects(store.create({ ...input, keyId }));
    await assert.rejects(store.update(host.id, { keyId }));
  }
  await assert.rejects(store.create({ ...input, keyId: key.id, privateKey }), {
    status: 400,
  });
  await assert.rejects(store.update(host.id, { keyId: key.id, privateKey }), {
    status: 400,
  });
  await assert.rejects(store.keyStore.create({ name: "", privateKey }), { status: 400 });
  await assert.rejects(store.keyStore.create({ name: "Bad", privateKey: "SECRET" }), {
    status: 400,
  });
  assert.throws(() => store.keyStore.rename(key.id, { name: "New", privateKey }), {
    status: 400,
  });
});

test("legacy hosts migrate once, deduplicate public identities and preserve original files", async (t) => {
  const { dataDir, input, privateKey, publicKey } = fixture(t);
  const hosts = [randomUUID(), randomUUID()].map((id, index) => ({
    ...input,
    id,
    name: `Legacy ${index}`,
    publicKey: `${publicKey} old-comment-${index}`,
    fingerprint: "SHA256:legacy",
    hostFingerprint: "SHA256:host",
    port: 22,
    createdAt: "2025-01-01T00:00:00.000Z",
  }));
  for (const host of hosts) {
    const dir = path.join(dataDir, "ssh/keys", host.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "identity"), privateKey);
    fs.writeFileSync(path.join(dir, "known_hosts"), `example.test ${publicKey}\n`);
  }
  fs.writeFileSync(path.join(dataDir, "ssh/accesses.json"), JSON.stringify(hosts));
  const migrated = new SshAccessStore({ dataDir });
  assert.ok(migrated.keyStore);
  assert.equal(migrated.keyStore.list().length, 1);
  const ids = migrated.list().map((host) => host.id);
  assert.deepEqual(
    ids,
    hosts.map((host) => host.id),
  );
  assert.equal(migrated.list()[0].keyId, migrated.list()[1].keyId);
  // Simulate interruption after catalog commit but before access references commit.
  fs.writeFileSync(path.join(dataDir, "ssh/accesses.json"), JSON.stringify(hosts));
  const restarted = new SshAccessStore({ dataDir });
  assert.deepEqual(restarted.list(), migrated.list());
  assert.equal(restarted.keyStore.list().length, 1);
  restarted.remove(hosts[0].id);
  for (const host of hosts)
    assert.equal(
      fs.readFileSync(path.join(dataDir, "ssh/keys", host.id, "identity"), "utf8"),
      privateKey,
    );
});

test("key deletion during async host create or update cannot commit a missing reference", async (t) => {
  let pause = false;
  let entered;
  let release;
  let started;
  let barrier;
  const run = async (command, args, options) => {
    if (pause && args.includes("-l")) {
      pause = false;
      entered();
      await barrier;
    }
    return runOpenSsh(command, args, options);
  };
  const { store, input } = fixture(t, { run });
  assert.ok(store.keyStore);
  const host = await store.create(input);
  for (const update of [false, true]) {
    const key = await store.keyStore.create({ name: "Temporary" });
    started = new Promise((resolve) => {
      entered = resolve;
    });
    barrier = new Promise((resolve) => {
      release = resolve;
    });
    pause = true;
    const operation = update
      ? store.update(host.id, { keyId: key.id })
      : store.create({ ...input, keyId: key.id });
    await started;
    store.keyStore.remove(key.id);
    release();
    await assert.rejects(operation, { status: 404 });
    assert.equal(store.list().length, 1);
    assert.notEqual(store.get(host.id).keyId, key.id);
  }
});

test("migration failures preserve original state and can recover without restarting", async (t) => {
  const { dataDir, input, privateKey, publicKey } = fixture(t);
  const host = {
    ...input,
    id: randomUUID(),
    publicKey,
    fingerprint: "SHA256:legacy",
    port: 22,
  };
  const file = path.join(dataDir, "ssh/accesses.json");
  const original = JSON.stringify([host]);
  fs.writeFileSync(file, original);
  const store = new SshAccessStore({ dataDir });
  assert.throws(() => store.list(), { status: 503 });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const directory = path.join(dataDir, "ssh/keys", host.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "identity"), privateKey);
  assert.equal(store.list()[0].id, host.id);
  const keyId = store.get(host.id).keyId;
  store.remove(host.id);
  assert.equal(fs.existsSync(path.join(directory, "identity")), true);
  store.keyStore.remove(keyId);
  assert.equal(fs.existsSync(path.join(directory, "identity")), false);
});

test("deleting a host during an async key replacement never resurrects it", async (t) => {
  let pause = false;
  let release;
  let enter;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const run = async (command, args, options) => {
    if (pause && args.includes("-l")) {
      enter();
      await barrier;
    }
    return runOpenSsh(command, args, options);
  };
  const { store, input } = fixture(t, { run });
  const host = await store.create(input);
  const key = await store.keyStore.create({ name: "Replacement" });
  pause = true;
  const operation = store.update(host.id, { keyId: key.id });
  await entered;
  store.remove(host.id);
  release();
  await assert.rejects(operation, { status: 404 });
  assert.deepEqual(store.list(), []);
  assert.equal(store.keyStore.list().length, 2);
});

test("interrupted multi-host migration retries without leaving duplicate private copies", async (t) => {
  const { dataDir, input, privateKey, publicKey } = fixture(t);
  const hosts = [randomUUID(), randomUUID()].map((id) => ({
    ...input,
    id,
    publicKey,
    fingerprint: "SHA256:legacy",
    port: 22,
  }));
  fs.writeFileSync(path.join(dataDir, "ssh/accesses.json"), JSON.stringify(hosts));
  for (const host of hosts)
    fs.mkdirSync(path.join(dataDir, "ssh/keys", host.id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "ssh/keys", hosts[0].id, "identity"), privateKey);
  const store = new SshAccessStore({ dataDir });
  assert.throws(() => store.list(), { status: 503 });
  fs.writeFileSync(path.join(dataDir, "ssh/keys", hosts[1].id, "identity"), privateKey);
  assert.equal(store.list().length, 2);
  assert.equal(fs.readdirSync(path.join(dataDir, "ssh/identities")).length, 1);
});
