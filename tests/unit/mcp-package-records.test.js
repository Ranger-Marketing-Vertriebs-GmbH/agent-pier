// tests/unit/mcp-package-records.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
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
  assert.throws(() =>
    servers.create(
      { name: "pkg", transport: "stdio", command: "/bin/sh" },
      { pendingCommand: true },
    ),
  );
  assert.throws(() =>
    servers.create(
      { name: "pkg", transport: "stdio", command: "/bin/sh" },
      { packageRecord: record() },
    ),
  );
  assert.deepEqual(servers.list(), []);
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
