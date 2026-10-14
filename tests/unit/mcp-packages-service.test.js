import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { toolchainRoot } from "../../server/features/mcp-packages/toolchains.js";
import { toolchainEntry } from "../../server/features/mcp-packages/toolchain-entry.js";

const registryUrl = "http://registry.test";
const integrity = "sha512-top";
const lockOf = (resolved = `${registryUrl}/x/-/x-1.0.0.tgz`) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/x": { version: "1.0.0", resolved, integrity } },
  });
const packument = {
  name: "x",
  "dist-tags": { latest: "1.0.0" },
  versions: { "1.0.0": { bin: { x: "index.js" }, dist: { integrity } } },
};

/** In-memory stand-ins for the server store, its package records and the changes. */
function harness(t, { toolchainDir, failSwitch = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-packages-unit-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const rows = new Map([
    [
      "s1",
      { id: "s1", transport: "stdio", command: "own", args: ["--flag"], revision: 1 },
    ],
  ]);
  const map = new Map();
  const records = {
    get: (id) => (map.has(id) ? { ...map.get(id) } : null),
    put: (id, fields) => map.set(id, { serverId: id, ...fields }),
    update: (id, fields) => map.has(id) && map.set(id, { ...map.get(id), ...fields }),
    remove: (id) => map.delete(id),
    all: () => [...map.values()].map((row) => ({ ...row })),
    installIds: () => new Set([...map.values()].map((r) => r.installId).filter(Boolean)),
  };
  const servers = {
    packages: records,
    get: (id) => ({ ...rows.get(id), source: records.get(id) ?? undefined }),
  };
  const switches = [];
  const changes = {
    update: async (id, patch) => {
      switches.push({ patch, record: records.get(id) });
      if (failSwitch) throw Object.assign(Error("conflict"), { status: 500 });
      rows.set(id, { ...rows.get(id), ...patch, revision: rows.get(id).revision + 1 });
    },
  };
  const npmCalls = [];
  const execute = async (_node, args, { cwd }) => {
    npmCalls.push(args[1]);
    if (args.includes("--package-lock-only"))
      fs.writeFileSync(path.join(cwd, "package-lock.json"), lockOf());
    if (args[1] === "ci") {
      const dir = path.join(cwd, "node_modules", "x");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dir, "index.js"), "");
    }
    return { stdout: "", stderr: "" };
  };
  const service = new McpPackages({
    dataDir,
    servers,
    changes,
    registry: registryUrl,
    download: async () => Buffer.from(JSON.stringify(packument)),
    toolchain: async () => ({
      kind: "node",
      version: "22.0.0",
      directory:
        toolchainDir?.(dataDir) ?? path.join(dataDir, "toolchains", "node-v22.0.0-test"),
      nodePath: process.execPath,
      npmCliPath: "/npm-cli.js",
    }),
    execute,
    environment: {},
  });
  return { dataDir, service, records, rows, switches, npmCalls };
}
const source = { registry: "npm", name: "x", version: "1.0.0" };
const attach = async (service) => {
  const { previewId } = await service.preview(source);
  return service.attach("s1", { source, previewId });
};
const installEntries = (dataDir) =>
  fs.readdirSync(path.join(dataDir, "mcp-packages", "installs"));

test("an attached package is ready before its command switches; toolchainDir is a toolchain folder", async (t) => {
  const { dataDir, service, records, rows, switches } = harness(t);
  await attach(service);
  await service.jobs.idle();
  const row = records.get("s1");
  assert.equal(row.status, "ready");
  assert.equal(row.toolchainDir, path.join(toolchainRoot(dataDir), "node-v22.0.0-test"));
  assert.match(path.basename(row.toolchainDir), /^node-/);
  assert.equal(path.dirname(row.toolchainDir), toolchainRoot(dataDir));
  assert.equal(switches.length, 1);
  assert.equal(switches[0].record.status, "ready");
  const server = rows.get("s1");
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.length, 2);
  assert.match(server.args[0], /node_modules\/x\/index\.js$/);
  assert.equal(server.args[1], "--flag");
  assert.deepEqual(installEntries(dataDir), [row.installId]);
});

test("a toolchain outside a node-* or python-* folder is never stored", async (t) => {
  const { service, records, npmCalls, dataDir } = harness(t, {
    toolchainDir: (dataDir) => toolchainRoot(dataDir),
  });
  await attach(service);
  await service.jobs.idle();
  assert.equal(records.get("s1").status, "failed");
  assert.equal(records.get("s1").errorCode, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE");
  assert.equal(records.get("s1").toolchainDir, null);
  assert.equal(npmCalls.includes("ci"), false);
  assert.deepEqual(installEntries(dataDir), []);
});

test("the lock is checked again before npm ci; a failed install leaves no stage", async (t) => {
  const { dataDir, service, records, npmCalls } = harness(t);
  const { previewId } = await service.preview(source);
  service.previews.get(previewId).lockText = lockOf("https://evil.example/x.tgz");
  await service.attach("s1", { source, previewId });
  await service.jobs.idle();
  assert.equal(service.jobs.get("s1").code, "MCP_PACKAGE_FOREIGN_SOURCE");
  assert.equal(records.get("s1").errorCode, "MCP_PACKAGE_FOREIGN_SOURCE");
  assert.equal(npmCalls.includes("ci"), false);
  assert.deepEqual(installEntries(dataDir), []);
});

test("a failed switch restores the previous record and removes the new install", async (t) => {
  const { dataDir, service, records, rows } = harness(t, { failSwitch: true });
  await attach(service);
  await service.jobs.idle();
  assert.equal(records.get("s1").status, "failed");
  assert.equal(records.get("s1").installId, null);
  assert.equal(rows.get("s1").command, "own");
  assert.deepEqual(installEntries(dataDir), []);
  const { job, error } = service.status("s1");
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.doesNotMatch(JSON.stringify({ job, error }), /conflict/);
});

test("reinstall validates the stored reference and lock before any job", async (t) => {
  const { service, records } = harness(t);
  await attach(service);
  await service.jobs.idle();
  const ready = records.get("s1");
  records.put("s1", { ...ready, version: "^1.0.0" });
  assert.throws(() => service.reinstall("s1"), { code: "MCP_PACKAGE_INVALID" });
  records.put("s1", { ...ready, lock: lockOf("https://evil.example/x.tgz") });
  assert.throws(() => service.reinstall("s1"), { code: "MCP_PACKAGE_FOREIGN_SOURCE" });
  assert.equal(service.jobs.get("s1").kind, "install");
});

test("toolchain entries are folders under this data dir's toolchain root, by name", () => {
  const root = toolchainRoot("/data");
  assert.equal(
    toolchainEntry("/data", "/private/data/toolchains/node-v1-x"),
    `${root}/node-v1-x`,
  );
  assert.equal(
    toolchainEntry("/data", "/data/toolchains/python-3-x"),
    `${root}/python-3-x`,
  );
  assert.equal(toolchainEntry("/data", root), null);
  assert.equal(toolchainEntry("/data", "/data"), null);
  assert.equal(toolchainEntry("/data", null), null);
});
