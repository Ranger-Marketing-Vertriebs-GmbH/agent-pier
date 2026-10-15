import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PackageRecords } from "../../server/features/mcp-packages/package-records.js";

const oldColumns = `
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
  lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
  install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed')),
  error_code TEXT, updated_at INTEGER NOT NULL`;
// The table as PR 2 created it: no constraints, no needs_scripts, three statuses.
const oldSchema = `
CREATE TABLE servers(id TEXT PRIMARY KEY);
CREATE TABLE server_packages(${oldColumns});
INSERT INTO servers VALUES ('s1');
INSERT INTO server_packages VALUES ('s1','pypi','x','1.0','x','x',1,'l','d','i',NULL,0,NULL,'failed',NULL,1);`;
// The table as the last release (main) creates it: every column, three statuses.
const mainSchema = `
CREATE TABLE servers(id TEXT PRIMARY KEY);
CREATE TABLE server_packages(${oldColumns},
  constraints TEXT NOT NULL DEFAULT '[]', needs_scripts INTEGER NOT NULL DEFAULT 0);
INSERT INTO servers VALUES ('n1'),('p1');
INSERT INTO server_packages VALUES ('n1','npm','srv','2.0.0','srv','bin/srv.js',0,'{"n":1}',
  'dn','sha512-n','inst-n',1,'/tc/node','ready',NULL,7,'[]',0);
INSERT INTO server_packages VALUES ('p1','pypi','tool','0.3','tool','tool',1,'{"p":1}',
  'dp','sha256-p','inst-p',0,'/tc/py','failed','MCP_X',9,'["a<2"]',1);`;

function database(t, sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-records-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "mcp.db"));
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(sql);
  return { db, dir };
}
const oldDatabase = (t) => database(t, oldSchema);
const tableSql = (db) =>
  db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='server_packages'",
    )
    .get().sql;

test("an old table gains the new columns, keeps its rows and accepts choosing", (t) => {
  const { db, dir } = oldDatabase(t);
  const records = new PackageRecords(db, dir);
  const row = records.get("s1");
  assert.equal(row.status, "failed");
  assert.equal(row.needsScripts, true, "backfilled from allow_scripts");
  assert.deepEqual(row.constraints, []);
  records.update("s1", { status: "choosing" });
  assert.equal(records.get("s1").status, "choosing");
  // Opening again changes nothing.
  new PackageRecords(db, dir);
  assert.equal(records.get("s1").status, "choosing");
});

test("a failing migration rolls back to the old table", (t) => {
  const { db, dir } = oldDatabase(t);
  const failing = {
    exec: (sql) => {
      if (/^UPDATE server_packages SET needs_scripts/.test(sql)) throw Error("disk I/O");
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
  };
  assert.throws(() => new PackageRecords(failing, dir), /disk I\/O/);
  const columns = db
    .prepare("PRAGMA table_info(server_packages)")
    .all()
    .map((c) => c.name);
  assert.equal(columns.includes("needs_scripts"), false);
  assert.equal(columns.includes("constraints"), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM server_packages").get().n, 1);
});

test("a failing rebuild keeps the release's table and its check", (t) => {
  const { db, dir } = database(t, mainSchema);
  const before = tableSql(db);
  const failing = {
    exec: (sql) => {
      if (/^DROP TABLE server_packages$/.test(sql)) throw Error("disk full");
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
  };
  assert.throws(() => new PackageRecords(failing, dir), /disk full/);
  assert.equal(tableSql(db), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM server_packages").get().n, 2);
  const leftover = db
    .prepare("SELECT name FROM sqlite_master WHERE name='server_packages_next'")
    .get();
  assert.equal(leftover, undefined);
});

test("a store of the last release keeps every column of both registries", (t) => {
  const { db, dir } = database(t, mainSchema);
  const before = db.prepare("SELECT * FROM server_packages ORDER BY server_id").all();
  const records = new PackageRecords(db, dir);
  assert.match(tableSql(db), /'choosing'/);
  assert.match(tableSql(db), /REFERENCES servers\(id\) ON DELETE CASCADE/);
  assert.deepEqual(
    db.prepare("SELECT * FROM server_packages ORDER BY server_id").all(),
    before,
  );
  assert.deepEqual(records.get("p1").constraints, ["a<2"]);
  records.update("n1", { status: "choosing" });
  // The rebuilt table still belongs to its server.
  db.exec("DELETE FROM servers WHERE id='n1'");
  assert.equal(records.get("n1"), null);
  assert.throws(() =>
    db.exec(
      "INSERT INTO server_packages(server_id,registry,name,version,program,program_path,lock,lock_digest,integrity,status,updated_at) VALUES ('none','npm','a','1','a','a','{}','d','i','ready',1)",
    ),
  );
  assert.throws(() => records.update("p1", { status: "unknown" }), /CHECK/);
});

test("a leftover rebuild table from an interrupted open is replaced", (t) => {
  const { db, dir } = database(
    t,
    `${mainSchema}
    CREATE TABLE server_packages_next(junk TEXT);`,
  );
  const records = new PackageRecords(db, dir);
  assert.equal(records.all().length, 2);
  const leftover = db
    .prepare("SELECT name FROM sqlite_master WHERE name='server_packages_next'")
    .get();
  assert.equal(leftover, undefined);
});

test("opening a current store takes no write lock", (t) => {
  const { db, dir } = database(t, "CREATE TABLE servers(id TEXT PRIMARY KEY);");
  new PackageRecords(db, dir);
  const statements = [];
  const watching = {
    exec: (sql) => {
      statements.push(sql);
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
  };
  new PackageRecords(watching, dir);
  assert.deepEqual(statements, []);
});
