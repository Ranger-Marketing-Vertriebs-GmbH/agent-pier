import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

async function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-forget-")),
  );
  const dataDir = path.join(root, "data");
  const stores = [];
  const open = () => {
    const store = new ProjectMemory({ dataDir, home: path.join(root, "home") });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = open();
  const folder = async (name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    return store.register(cwd);
  };
  return { root, dataDir, store, open, folder, project: await folder("repo") };
}

// The bytes of every memory database file, including WAL and migration backups.
function storedBytes(store) {
  return fs
    .readdirSync(store.root)
    .filter((name) => name.startsWith("memory.sqlite"))
    .map((name) => fs.readFileSync(path.join(store.root, name)));
}
function stored(store, text) {
  const needle = Buffer.from(text);
  return storedBytes(store).some((bytes) => bytes.includes(needle));
}

function secretEntry(store, projectId, secret) {
  const first = store.write(
    projectId,
    { title: "Deploy token", content: `token ${secret}-v1`, requestId: "req-1" },
    { kind: "session", sessionId: "s1", accountId: "a1", tool: "codex" },
  );
  store.write(projectId, {
    id: first.id,
    title: "Deploy token",
    content: `token ${secret}-v2`,
    expectedRevision: 1,
  });
  return store.archive(projectId, first.id, { expectedRevision: 2 });
}

test("forget removes every revision, the entry and its write receipts", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-a");
  const kept = f.store.write(f.project.id, { title: "Build", content: "npm test" });
  const result = f.store.forget(f.project.id, entry.id, {
    expectedRevision: 3,
    reason: "Leaked token",
  });
  assert.deepEqual(result, {
    id: entry.id,
    projectId: f.project.id,
    revisions: 3,
    removedBackups: 0,
  });
  for (const read of [
    () => f.store.read(f.project.id, entry.id),
    () => f.store.read(f.project.id, entry.id, { revision: 1 }),
    () => f.store.revisions(f.project.id, entry.id),
  ])
    assert.throws(read, { status: 404 });
  assert.equal(f.store.writeReceipt(f.project.id, "s1", "req-1"), null);
  assert.equal(f.store.list(f.project.id, { archived: true }).total, 0);
  assert.equal(f.store.read(f.project.id, kept.id).content, "npm test");
  const tombstones = f.store.db.prepare("SELECT * FROM tombstones").all();
  assert.equal(tombstones.length, 2); // revision 3 repeats revision 2's text.
  assert.equal(JSON.stringify(tombstones).includes("fixture-secret-a"), false);
  assert.deepEqual(
    { ...tombstones[0], hash: undefined, created_at: undefined },
    {
      project_id: f.project.id,
      entry_id: entry.id,
      hash: undefined,
      reason: "Leaked token",
      actor: "user",
      created_at: undefined,
    },
  );
});

test("forget refuses a stale revision and leaves the entry intact", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-b");
  assert.throws(() => f.store.forget(f.project.id, entry.id, { expectedRevision: 2 }), {
    status: 409,
  });
  assert.throws(() => f.store.forget(f.project.id, entry.id, {}), { status: 400 });
  assert.throws(
    () =>
      f.store.forget(f.project.id, entry.id, {
        expectedRevision: 3,
        reason: "x".repeat(501),
      }),
    { status: 400 },
  );
  assert.equal(f.store.revisions(f.project.id, entry.id).total, 3);
});

test("forgotten text cannot be written again in its project", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-c");
  f.store.forget(f.project.id, entry.id, { expectedRevision: 3 });
  for (const content of ["token fixture-secret-c-v1", "  token  fixture-secret-c-v2\n"])
    assert.throws(
      () => f.store.write(f.project.id, { title: " Deploy token ", content }),
      { status: 422, message: serverMessages.memory.forgottenContent },
    );
  const other = f.store.write(f.project.id, {
    title: "Deploy token",
    content: "rotated",
  });
  assert.throws(
    () =>
      f.store.write(f.project.id, {
        id: other.id,
        title: "Deploy token",
        content: "token fixture-secret-c-v1",
        expectedRevision: 1,
      }),
    { status: 422 },
  );
  const second = await f.folder("second");
  assert.equal(
    f.store.write(second.id, {
      title: "Deploy token",
      content: "token fixture-secret-c-v1",
    }).revision,
    1,
  );
});

test("tombstones follow a merged project", async (t) => {
  const f = await fixture(t);
  const target = await f.folder("target");
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-d");
  f.store.forget(f.project.id, entry.id, { expectedRevision: 3 });
  f.store.merge(f.project.id, f.store.scopeOf(target.id));
  assert.throws(
    () =>
      f.store.write(target.id, {
        title: "Deploy token",
        content: "token fixture-secret-d-v2",
      }),
    { status: 422 },
  );
});

test("forget purges the content bytes from the database files", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-e");
  const backup = f.store.backup("fixture");
  assert.equal(stored(f.store, "fixture-secret-e"), true);
  f.store.forget(f.project.id, entry.id, { expectedRevision: 3 });
  // Without the owner's confirmation the migration backup stays and still holds it.
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.readFileSync(backup).includes(Buffer.from("fixture-secret-e")), true);
  fs.rmSync(backup);
  assert.equal(stored(f.store, "fixture-secret-e"), false);
  f.store.close();
  const reopened = f.open();
  assert.equal(stored(reopened, "fixture-secret-e"), false);
  assert.throws(() => reopened.read(f.project.id, entry.id), { status: 404 });
});

test("forget removes migration backups only on the owner's confirmation", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-f");
  const backups = [f.store.backup("fixture"), f.store.backup("other")];
  const unrelated = path.join(f.store.root, "notes.txt");
  fs.writeFileSync(unrelated, "fixture-secret-f");
  const result = f.store.forget(f.project.id, entry.id, {
    expectedRevision: 3,
    removeBackups: true,
  });
  assert.equal(result.removedBackups, 2);
  for (const file of backups) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(stored(f.store, "fixture-secret-f"), false);
  assert.throws(
    () =>
      f.store.forget(f.project.id, "missing", {
        expectedRevision: 1,
        removeBackups: "yes",
      }),
    { status: 400 },
  );
});
