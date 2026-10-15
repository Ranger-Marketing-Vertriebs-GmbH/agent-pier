// tests/unit/mcp-package-records.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { DatabaseSync } from "node:sqlite";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { PackageRecords } from "../../server/features/mcp-packages/package-records.js";
import {
  commitInstall,
  stageInstall,
} from "../../server/features/mcp-packages/package-store.js";

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-records-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    servers: new McpServerStore({ dataDir, pathEnv: "", exists: () => true }),
  };
}
const record = (extra = {}) => ({
  registry: "npm",
  name: "server-x",
  version: "1.0.0",
  program: "server-x",
  programPath: "index.js",
  allowScripts: false,
  lock: "{}",
  lockDigest: "d".repeat(64),
  integrity: "sha512-x",
  installId: null,
  leadingArgs: 0,
  toolchainDir: "/data/toolchains/node",
  status: "installing",
  errorCode: null,
  ...extra,
});
const pending = (servers, input = {}, extra = {}) =>
  servers.create(
    { name: "pkg", transport: "stdio", ...input },
    { pendingCommand: true, packageRecord: record(extra) },
  );

test("a pending packaged server has no command, shows its args and is not compiled", (t) => {
  const { servers } = store(t);
  const server = pending(servers, { args: ["--x"] });
  assert.equal(server.command, undefined);
  assert.deepEqual(server.args, ["--x"]);
  assert.deepEqual(server.source, {
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
    program: "server-x",
    allowScripts: false,
    status: "installing",
    errorCode: null,
    leadingArgs: 0,
    constraints: [],
  });
  const definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.command, null);
  assert.equal(definition.packageStatus, "installing");
});

test("an owner edit of a pending server keeps it pending", (t) => {
  const { servers } = store(t);
  const server = pending(servers, { args: ["--x"] });
  const renamed = servers.update(server.id, {
    revision: server.revision,
    name: "renamed",
  });
  assert.equal(renamed.command, undefined);
  assert.deepEqual(renamed.args, ["--x"]);
  assert.equal(renamed.source.status, "installing");
});

test("pendingCommand never stores an owner command; a record needs pendingCommand", (t) => {
  const { servers } = store(t);
  assert.throws(
    () =>
      servers.create(
        { name: "pkg", transport: "stdio", command: "/bin/sh" },
        { pendingCommand: true },
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      servers.create(
        { name: "pkg", transport: "stdio", command: "/bin/sh" },
        { packageRecord: record() },
      ),
    { status: 400 },
  );
  assert.deepEqual(servers.list(), []);
});

test("only a literal true pendingCommand stores a server without a command", (t) => {
  const { servers } = store(t);
  assert.throws(
    () => servers.create({ name: "pkg", transport: "stdio" }, { pendingCommand: "yes" }),
    { status: 400 },
  );
  assert.deepEqual(servers.list(), []);
});

test("listing servers reads all package records in one query", (t) => {
  const { servers } = store(t);
  pending(servers, {}, {});
  servers.create(
    { name: "pkg2", transport: "stdio" },
    { pendingCommand: true, packageRecord: record() },
  );
  const get = t.mock.method(servers.packages, "get");
  assert.equal(servers.list().length, 2);
  assert.equal(servers.definitions().length, 2);
  assert.equal(get.mock.callCount(), 0);
});

test("a choosing record whose install is gone is missing", (t) => {
  const { servers, dataDir } = store(t);
  const { installId, stage } = stageInstall(dataDir);
  // A build waiting for the owner's choice lists its programs in the receipt.
  const programs = [
    { name: "a", path: "a" },
    { name: "b", path: "b" },
  ];
  commitInstall(dataDir, {
    installId,
    stage,
    receipt: { lockDigest: "d".repeat(64), program: null, programs },
  });
  const server = pending(servers, {}, { status: "choosing", installId });
  assert.equal(servers.get(server.id).source.status, "choosing");
  const definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.packageStatus, "choosing");
  assert.deepEqual(definition.managedDirs, []);
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", installId), {
    recursive: true,
  });
  assert.equal(servers.get(server.id).source.status, "missing");
});

test("the record is stored before the CLIs are reconciled", async (t) => {
  const { servers } = store(t);
  const seen = [];
  const changes = new CentralMcpChanges({
    servers,
    onSaved: async () => seen.push(servers.definitions()),
  });
  await changes.create(
    { name: "pkg", transport: "stdio", args: [] },
    {
      confirmStdio: true,
      clis: ["claude"],
      pendingCommand: true,
      packageRecord: record(),
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].packageStatus, "installing");
  assert.deepEqual(servers.targetsOf(seen[0][0].id).clis, ["claude"]);
});

test("a ready record whose install vanished reports missing", (t) => {
  const { dataDir, servers } = store(t);
  const server = pending(servers);
  const { installId, stage } = stageInstall(dataDir);
  commitInstall(dataDir, { installId, stage, receipt: { lockDigest: "d".repeat(64) } });
  servers.packages.put(server.id, record({ status: "ready", installId, leadingArgs: 1 }));
  let definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.packageStatus, "ready");
  assert.deepEqual(definition.managedDirs, [
    path.join(dataDir, "mcp-packages", "installs", installId),
    "/data/toolchains/node",
  ]);
  assert.equal(servers.get(server.id).source.leadingArgs, 1);
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", installId), {
    recursive: true,
  });
  definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.packageStatus, "missing");
  assert.equal(servers.get(server.id).source.status, "missing");
});

test("removing the server removes its record", (t) => {
  const { servers } = store(t);
  const server = pending(servers);
  servers.remove(server.id);
  assert.equal(servers.packages.get(server.id), null);
});

test("an own-command server carries no package fields", (t) => {
  const { servers } = store(t);
  const server = servers.create({ name: "own", transport: "stdio", command: "/bin/x" });
  assert.equal(servers.get(server.id).source, undefined);
  assert.equal(servers.definitions()[0].packageStatus, undefined);
});

test("constraints are stored as a list and shown with the source", (t) => {
  const { servers } = store(t);
  const server = pending(servers, {}, { registry: "pypi", constraints: ["fastmcp<4"] });
  assert.deepEqual(servers.packages.get(server.id).constraints, ["fastmcp<4"]);
  assert.deepEqual(servers.get(server.id).source.constraints, ["fastmcp<4"]);
  servers.packages.update(server.id, { status: "failed" });
  assert.deepEqual(servers.packages.get(server.id).constraints, ["fastmcp<4"]);
});

test("whether a build was needed is stored with the record, never shown", (t) => {
  const { servers } = store(t);
  const plain = pending(servers);
  assert.equal(servers.packages.get(plain.id).needsScripts, false);
  const built = pending(servers, { name: "built" }, { needsScripts: true });
  assert.equal(servers.packages.get(built.id).needsScripts, true);
  assert.equal(servers.get(built.id).source.needsScripts, undefined);
});

/** A server_packages table as plan 2 created it: no constraints, no needs_scripts. */
function oldStore() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE servers(id TEXT PRIMARY KEY)");
  db.exec(`CREATE TABLE server_packages(
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
    program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
    lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
    install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
    status TEXT NOT NULL CHECK(status IN ('installing','ready','failed')),
    error_code TEXT, updated_at INTEGER NOT NULL)`);
  db.exec("INSERT INTO servers VALUES ('s1'),('s2')");
  db.exec(
    "INSERT INTO server_packages VALUES ('s1','npm','x','1.0.0','x','i.js',0,'{}','d','i',NULL,0,NULL,'installing',NULL,1)",
  );
  db.exec(
    "INSERT INTO server_packages VALUES ('s2','npm','y','1.0.0','y','i.js',1,'{}','d','i',NULL,0,NULL,'installing',NULL,1)",
  );
  return db;
}

test("a store from before constraints gains the columns; old rows keep their install mode", () => {
  const db = oldStore();
  const records = new PackageRecords(db, "/unused");
  assert.deepEqual(records.get("s1").constraints, []);
  assert.equal(records.get("s1").needsScripts, false);
  // As before the column: without a receipt the owner's opt-in decided.
  assert.equal(records.get("s2").needsScripts, true);
  const columns = db
    .prepare("PRAGMA table_info(server_packages)")
    .all()
    .map((column) => column.name);
  assert.ok(columns.includes("constraints") && columns.includes("needs_scripts"));
  // Opening the migrated store again changes nothing.
  new PackageRecords(db, "/unused");
  assert.equal(new PackageRecords(db, "/unused").get("s2").needsScripts, true);
});

test("a stored constraints value that is not a list of strings reads as none", () => {
  const db = oldStore();
  const records = new PackageRecords(db, "/unused");
  for (const value of ["not json", "{}", '["a<1",2]', "null", '"a<1"']) {
    db.prepare("UPDATE server_packages SET constraints=? WHERE server_id='s1'").run(
      value,
    );
    assert.deepEqual(records.get("s1").constraints, [], value);
  }
});
