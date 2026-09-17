import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshCatalog } from "../../server/features/ssh/ssh-catalog.js";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-catalog-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  return { dataDir, catalog };
}
test("concurrent transactions retain both writes and nested transactions reuse draft", async (t) => {
  const { catalog } = fixture(t);
  await Promise.all(
    ["a", "b"].map((id) =>
      catalog.run(async () => {
        await Promise.resolve();
        await catalog.run(() =>
          catalog.replacePart("projects", [...catalog.read().projects, { id }]),
        );
      }),
    ),
  );
  assert.deepEqual(
    catalog.read().projects.map((x) => x.id),
    ["a", "b"],
  );
});
test("failed transactions preserve published snapshot and execute rollback only", async (t) => {
  const { catalog } = fixture(t);
  let rollback = false,
    committed = false;
  await assert.rejects(
    catalog.run(() => {
      catalog.replacePart("projects", [{ id: "a" }]);
      catalog.afterRollback(() => {
        rollback = true;
      });
      catalog.afterCommit(() => {
        committed = true;
      });
      throw Error("abort");
    }),
    /abort/,
  );
  assert.deepEqual(catalog.read().projects, []);
  assert.equal(rollback, true);
  assert.equal(committed, false);
});
test("migration revokes capabilities only once and archives legacy files", (t) => {
  const { dataDir, catalog } = fixture(t);
  fs.rmSync(catalog.file);
  const root = path.join(dataDir, "ssh");
  fs.mkdirSync(path.join(root, "capabilities", "session"), { recursive: true });
  const capability = path.join(root, "capabilities", "session", "capability.json");
  fs.writeFileSync(capability, "{}");
  fs.writeFileSync(path.join(root, "keys.json"), "[]");
  fs.writeFileSync(path.join(root, "accesses.json"), "[]");
  catalog.migrate();
  assert.equal(fs.existsSync(capability), false);
  assert.equal(fs.existsSync(path.join(root, "keys.json")), false);
  fs.mkdirSync(path.dirname(capability), { recursive: true });
  fs.writeFileSync(capability, "{}");
  catalog.migrate();
  assert.equal(fs.existsSync(capability), true);
});

test("stores publish project ownership atomically and rollback prepared identity files", async (t) => {
  const { SshAccessStore } =
    await import("../../server/features/ssh/ssh-access-store.js");
  const { catalog, dataDir } = fixture(t);
  const store = new SshAccessStore({ dataDir, catalog });
  let key;
  await assert.rejects(
    catalog.run(async () => {
      key = await store.keyStore.create({ name: "Key", projectId: "project-a" });
      throw Error("abort");
    }),
    /abort/,
  );
  assert.deepEqual(store.keyStore.list(), []);
  assert.equal(fs.existsSync(store.keyStore.identityDirectory(key.id)), false);
  key = await store.keyStore.create({ name: "Key", projectId: "project-a" });
  const host = await store.create({
    name: "Host",
    host: "example.test",
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
    projectId: "project-a",
  });
  await assert.rejects(
    store.create({
      name: "Other",
      host: "example.test",
      username: "deploy",
      keyId: key.id,
      hostKey: key.publicKey,
      projectId: "project-b",
    }),
    { status: 409 },
  );
  const connection = store.connection(host.id);
  const pin = fs.readFileSync(path.join(connection.cwd, "known_hosts"), "utf8");
  const replacement = await store.keyStore.create({
    name: "Replacement",
    projectId: "project-a",
  });
  await store.update(host.id, { name: "Renamed", hostKey: replacement.publicKey });
  assert.notEqual(store.revision(host.id), connection.revision);
  assert.equal(fs.readFileSync(path.join(connection.cwd, "known_hosts"), "utf8"), pin);
  assert.equal(typeof connection.revision, "string");
  connection.cleanup();
  assert.equal(fs.existsSync(connection.cwd), false);
  const reader = new SshAccessStore({ dataDir });
  assert.equal(reader.get(host.id).projectId, "project-a");
  await assert.rejects(reader.keyStore.create({ name: "Denied" }), { status: 503 });
  const exported = store.keyStore.openPrivate(key.id);
  await store.remove(host.id);
  await store.keyStore.remove(key.id);
  assert.match(fs.readFileSync(exported.fd, "utf8"), /PRIVATE KEY/);
  fs.closeSync(exported.fd);
});

test("oversized legacy catalogs preserve reads, reject growth and allow deletion tombstones", async (t) => {
  const { catalog } = fixture(t);
  const snapshot = catalog.read();
  snapshot.projects.push({ id: "large", padding: "x".repeat(16 * 1024 * 1024) });
  snapshot.keys.push({ id: "key" });
  snapshot.receipts = Array.from({ length: 30 }, (_, i) => ({
    requestId: String(i),
    resourceId: "key",
  }));
  fs.writeFileSync(catalog.file, JSON.stringify(snapshot));
  await assert.rejects(
    catalog.run(() =>
      catalog.replacePart("projects", [...catalog.read().projects, { id: "new" }]),
    ),
    { code: "SSH_STORAGE_LIMIT" },
  );
  await catalog.run(() => {
    catalog.replacePart("keys", []);
    catalog.tombstone("key");
  });
  assert.equal(
    catalog.read().receipts.every((r) => r.tombstone),
    true,
  );
});
test("startup recovers interrupted archival and only proven unpublished identities", (t) => {
  const { catalog } = fixture(t);
  fs.writeFileSync(
    path.join(catalog.root, "migration.json"),
    JSON.stringify({ phase: "cutover" }),
  );
  fs.writeFileSync(path.join(catalog.root, "accesses.json"), "[]");
  const owned = path.join(
    catalog.root,
    "identities",
    "11111111-1111-1111-1111-111111111111",
  );
  const foreign = path.join(
    catalog.root,
    "identities",
    "22222222-2222-2222-2222-222222222222",
  );
  fs.mkdirSync(owned, { recursive: true });
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(owned, ".catalog-owned"), "");
  catalog.migrate();
  assert.equal(fs.existsSync(path.join(catalog.root, "accesses.json")), false);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(foreign), true);
});

test("prepared keys stay invisible until publish and discarded preparation cleans files", async (t) => {
  const { SshAccessStore } =
    await import("../../server/features/ssh/ssh-access-store.js");
  const { catalog, dataDir } = fixture(t);
  const keys = new SshAccessStore({ catalog, dataDir }).keyStore;
  const prepared = await keys.prepare({ name: "Prepared", projectId: "a" });
  assert.deepEqual(keys.list(), []);
  assert.equal(fs.existsSync(keys.identityDirectory(prepared.id)), false);
  const saved = await keys.publish(prepared);
  assert.equal(saved.publicKey, prepared.publicKey);
  prepared.cleanup();
  assert.equal(fs.existsSync(keys.identityDirectory(saved.id)), true);
  const discarded = await keys.prepare({ name: "Discarded" });
  discarded.cleanup();
  assert.deepEqual(fs.readdirSync(path.join(catalog.root, "staging")), []);
});

test("connection revision describes its captured endpoint across a concurrent publication", async (t) => {
  const { SshAccessStore } =
    await import("../../server/features/ssh/ssh-access-store.js");
  const { catalog, dataDir } = fixture(t);
  const store = new SshAccessStore({ catalog, dataDir });
  const key = await store.keyStore.create({ name: "Key" });
  const original = await store.create({
    name: "Host",
    host: "old.example.test",
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
  });
  const originalRevision = store.revision(original.id);
  await store.update(original.id, { host: "new.example.test", hostKey: key.publicKey });
  const currentRevision = store.revision(original.id);
  const get = store.get.bind(store);
  let reads = 0;
  store.get = (id) => (reads++ === 0 ? original : get(id));
  const connection = store.connection(original.id);
  t.after(connection.cleanup);
  assert.equal(connection.args.at(-1), "old.example.test");
  assert.equal(connection.revision, originalRevision);
  assert.notEqual(connection.revision, currentRevision);
});
