import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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
    purged: true,
    redacted: true,
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
  // Text already checkpointed into the main file must leave it too.
  f.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const main = path.join(f.store.root, "memory.sqlite");
  assert.equal(fs.readFileSync(main).includes(Buffer.from("fixture-secret-e")), true);
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

test("forget purges the entry from the full-text index and its shadow tables", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.fullText, true);
  // One token with no prefix shared with others, so the index segments hold it whole.
  const token = "zqxjfixturetoken";
  const first = f.store.write(f.project.id, { title: "Index", content: `${token}one` });
  f.store.write(f.project.id, {
    id: first.id,
    title: "Index",
    content: `${token}two`,
    expectedRevision: 1,
  });
  f.store.write(f.project.id, { title: "Other", content: "unrelated words" });
  const segments = () =>
    f.store.db
      .prepare("SELECT block FROM memory_search_data")
      .all()
      .some((row) => Buffer.from(row.block).includes(Buffer.from(token)));
  assert.equal(segments(), true);
  assert.equal(f.store.list(f.project.id, { query: `${token}two` }).total, 1);
  f.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(stored(f.store, token), true);
  f.store.forget(f.project.id, first.id, { expectedRevision: 2 });
  assert.equal(segments(), false);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memory_search").get().n, 1);
  assert.equal(stored(f.store, token), false);
  assert.equal(f.store.list(f.project.id, { query: "unrelated" }).total, 1);
  f.store.close();
  assert.equal(stored(f.open(), token), false);
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

test("tombstones follow a plain project adopted after git init", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-g");
  f.store.forget(f.project.id, entry.id, { expectedRevision: 3 });
  execFileSync("git", ["init", "-q", f.project.cwd]);
  const adopted = await f.store.register(f.project.cwd);
  assert.notEqual(adopted.id, f.project.id);
  assert.equal(f.store.reboundTo(f.project.id), adopted.id);
  assert.throws(
    () =>
      f.store.write(adopted.id, {
        title: "Deploy token",
        content: "token fixture-secret-g-v1",
      }),
    { status: 422 },
  );
});

test("a failed VACUUM still answers, reports the purge and retries it later", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-h");
  const backup = f.store.backup("fixture");
  const exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = (sql) => {
    if (sql === "VACUUM") throw new Error("database or disk is full");
    return exec(sql);
  };
  const result = f.store.forget(f.project.id, entry.id, {
    expectedRevision: 3,
    removeBackups: true,
  });
  assert.equal(result.purged, false);
  assert.equal(result.notice, serverMessages.memory.purgePending);
  // The remaining steps still ran: the backup is gone and the entry stays forgotten.
  assert.equal(result.removedBackups, 1);
  assert.equal(fs.existsSync(backup), false);
  assert.throws(() => f.store.read(f.project.id, entry.id), { status: 404 });
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM purges WHERE files=1").get().n,
    1,
  );
  delete f.store.db.exec;
  // A backup made after the forget holds no forgotten text; the retry keeps it.
  const later = f.store.backup("later");
  f.store.close();
  // The next start retries the purge and clears its marker.
  const reopened = f.open();
  assert.equal(fs.existsSync(later), true);
  fs.rmSync(later);
  assert.equal(stored(reopened, "fixture-secret-h"), false);
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) AS n FROM purges WHERE files=1").get().n,
    0,
  );
});

test("a reader holding the log open delays the purge until the next forget", async (t) => {
  const f = await fixture(t);
  const entry = secretEntry(f.store, f.project.id, "fixture-secret-i");
  const later = f.store.write(f.project.id, { title: "Later", content: "unrelated" });
  f.store.db.exec("PRAGMA busy_timeout=50");
  const reader = new DatabaseSync(path.join(f.store.root, "memory.sqlite"));
  t.after(() => reader.isOpen && reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM revisions").get();
  const result = f.store.forget(f.project.id, entry.id, { expectedRevision: 3 });
  assert.equal(result.purged, false);
  reader.exec("COMMIT");
  reader.close();
  const next = f.store.forget(f.project.id, later.id, { expectedRevision: 1 });
  assert.equal(next.purged, true);
  assert.equal(stored(f.store, "fixture-secret-i"), false);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM purges WHERE files=1").get().n,
    0,
  );
});
