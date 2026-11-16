import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { purgeProjects } from "../../server/features/memory/project-deletions.js";

const body = (extra = {}) => ({
  name: "app",
  folderMissing: false,
  dev: "1",
  ino: "2",
  projectIds: ["p1"],
  repositoryIds: [],
  busIds: [],
  sessionIds: [],
  runIds: [],
  rebuildIds: [],
  nested: [],
  report: { unsavedGitWork: false, endedSessionIds: [], endedProcesses: [] },
  ...extra,
});

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-deletions-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const open = () => new ProjectMemory({ dataDir: path.join(root, "data") });
  const folder = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { root, open, folder };
}

test("a deletion record survives reopening the database", (t) => {
  const { open } = fixture(t);
  let memory = open();
  memory.deletions.mark("/work/app", body());
  memory.close();
  memory = open();
  t.after(() => memory.close());
  const record = memory.deletions.get("/work/app");
  assert.equal(record.state, "deleting");
  assert.equal(record.error, null);
  assert.deepEqual(record.body, body());
  assert.deepEqual(
    memory.deletions.list().map((entry) => entry.path),
    ["/work/app"],
  );
  memory.deletions.drop("/work/app");
  assert.equal(memory.deletions.get("/work/app"), null);
});

test("fail and again switch the state and keep the body", (t) => {
  const { open } = fixture(t);
  const memory = open();
  t.after(() => memory.close());
  memory.deletions.mark("/work/app", body());
  memory.deletions.fail("/work/app", "EACCES");
  const failed = memory.deletions.get("/work/app");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "EACCES");
  assert.deepEqual(failed.body, body());
  const again = memory.deletions.again("/work/app");
  assert.equal(again.state, "deleting");
  assert.equal(again.error, null);
  assert.deepEqual(again.body, body());
});

test("purgeProjects removes rows, entries, revisions, receipts, tombstones, capabilities, rebinds and merges", async (t) => {
  const { open, folder } = fixture(t);
  const memory = open();
  t.after(() => memory.close());
  const a = await memory.register(folder("a"));
  const b = await memory.register(folder("b"));
  const note = (project, title, content) =>
    memory.write(project.id, { title, content, requestId: `req-${title}` });
  note(a, "alpha", "gone with the project");
  const forgotten = note(a, "beta", "forgotten before the purge");
  memory.forget(a.id, forgotten.id, {
    expectedRevision: forgotten.revision,
    reason: "test",
  });
  note(b, "kept", "kept text");
  const { db } = memory;
  db.prepare("INSERT INTO capabilities VALUES (?,?,?,?,?,?)").run(
    "s1",
    a.id,
    "acc",
    "claude",
    "hash",
    1,
  );
  const now = new Date().toISOString();
  db.prepare("INSERT INTO project_rebinds VALUES (?,?,?)").run("x", a.id, now);
  db.prepare("INSERT INTO project_merges VALUES (?,?,?)").run("y", a.id, now);

  const count = (table, id) =>
    db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`).get(id).n;
  for (const table of ["entries", "requests", "tombstones", "capabilities"])
    assert.ok(count(table, a.id) > 0, `${table} fixture`);
  const entryIds = db
    .prepare("SELECT id FROM entries WHERE project_id=?")
    .all(a.id)
    .map((row) => row.id);
  // An unfinished purge of a forgotten entry, and the search terms of every entry.
  db.prepare("INSERT OR REPLACE INTO purges VALUES (?,1,1,?)").run(entryIds[0], now);
  const indexed = (ids) =>
    ids.length && memory.fullText
      ? db
          .prepare(
            `SELECT COUNT(*) n FROM memory_search WHERE entry_id IN (${ids.map(() => "?").join(",")})`,
          )
          .get(...ids).n
      : 0;
  const purges = () =>
    db
      .prepare(
        `SELECT COUNT(*) n FROM purges WHERE entry_id IN (${entryIds.map(() => "?").join(",")})`,
      )
      .get(...entryIds).n;
  assert.equal(purges(), 1);
  if (memory.fullText) assert.ok(indexed(entryIds) > 0, "search terms fixture");
  assert.equal(memory.list(a.id, { query: "gone" }).items.length, 1);

  assert.equal(purgeProjects(memory, [a.id]) > 0, true);
  for (const table of ["entries", "requests", "tombstones", "capabilities"])
    assert.equal(count(table, a.id), 0, table);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM projects WHERE id=?").get(a.id).n, 0);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM revisions r LEFT JOIN entries e ON e.id=r.entry_id WHERE e.id IS NULL",
      )
      .get().n,
    0,
  );
  for (const table of ["project_rebinds", "project_merges"])
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE from_id=? OR to_id=?`)
        .get(a.id, a.id).n,
      0,
      table,
    );
  assert.equal(purges(), 0);
  assert.equal(indexed(entryIds), 0);
  assert.equal(memory.hasProject(b.id), true);
  assert.equal(memory.list(b.id, { query: "kept" }).items.length, 1);
  assert.equal(memory.list(b.id, {}).items.length, 1);
  assert.equal(purgeProjects(memory, []), 0);
});
