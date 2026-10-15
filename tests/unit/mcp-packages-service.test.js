import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { toolchainRoot } from "../../server/features/mcp-packages/toolchains.js";
import { toolchainEntry } from "../../server/features/mcp-packages/toolchain-entry.js";
import {
  pypiIndexRegistry,
  pythonAdapter,
} from "../../server/features/mcp-packages/python-adapter.js";

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
function harness(
  t,
  { toolchainDir, failSwitch = false, afterCommit, ciOutput, adapters } = {},
) {
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
      await afterCommit?.();
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
      return { stdout: ciOutput?.(cwd) ?? "", stderr: "" };
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
    ...(adapters ? { adapters } : {}),
  });
  return { dataDir, service, records, rows, switches, npmCalls };
}
const source = { registry: "npm", name: "x", version: "1.0.0" };
const attach = async (service) => {
  const { previewId } = await service.preview(source);
  return service.attach("s1", { source, previewId });
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
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

test("a running detach refuses installs; afterwards the record is gone and no job ran", async (t) => {
  const { service, records, npmCalls } = harness(t);
  await attach(service);
  await service.jobs.idle();
  const ciRuns = npmCalls.filter((call) => call === "ci").length;
  const held = deferred();
  const detaching = service.detach("s1", () => held.promise);
  assert.throws(() => service.reinstall("s1"), { code: "MCP_PACKAGE_BUSY" });
  const { previewId } = await service.preview(source);
  await assert.rejects(service.updatePackage("s1", { version: "1.0.0", previewId }), {
    code: "MCP_PACKAGE_BUSY",
  });
  assert.ok(service.previews.has(previewId));
  held.resolve();
  await detaching;
  await service.jobs.idle();
  assert.equal(records.get("s1"), null);
  assert.equal(service.jobs.get("s1").kind, "install");
  assert.equal(npmCalls.filter((call) => call === "ci").length, ciRuns);
});

test("an owner edit with the switched revision keeps the generated args", async (t) => {
  const reached = deferred();
  const held = deferred();
  const { service, rows } = harness(t, {
    afterCommit: () => {
      reached.resolve();
      return held.promise;
    },
  });
  await attach(service);
  await reached.promise;
  const program = rows.get("s1").args[0];
  assert.match(program, /node_modules\/x\/index\.js$/);
  const patch = service.prepareUpdate("s1", {
    revision: rows.get("s1").revision,
    args: ["--new"],
  });
  assert.deepEqual(patch.args, [program, "--new"]);
  held.resolve();
  await service.jobs.idle();
});

test("owner args drop the generated leading args of a ready package", async (t) => {
  const { service, rows } = harness(t);
  assert.deepEqual(service.ownerArgs("s1"), ["--flag"]);
  await attach(service);
  await service.jobs.idle();
  assert.match(rows.get("s1").args[0], /node_modules\/x\/index\.js$/);
  assert.deepEqual(service.ownerArgs("s1"), ["--flag"]);
});

test("a busy server refuses before its preview is taken or a stage is made", async (t) => {
  const reached = deferred();
  const held = deferred();
  const { dataDir, service } = harness(t, {
    afterCommit: () => {
      reached.resolve();
      return held.promise;
    },
  });
  await attach(service);
  await reached.promise;
  const before = installEntries(dataDir);
  const { previewId } = await service.preview(source);
  await assert.rejects(service.updatePackage("s1", { version: "1.0.0", previewId }), {
    code: "MCP_PACKAGE_BUSY",
  });
  assert.throws(() => service.reinstall("s1"), { code: "MCP_PACKAGE_BUSY" });
  assert.ok(service.previews.has(previewId));
  assert.deepEqual(installEntries(dataDir), before);
  held.resolve();
  await service.jobs.idle();
});

test("concurrent attaches: the second is busy and keeps the first's record", async (t) => {
  const { service, records } = harness(t);
  const first = await service.preview(source);
  const second = await service.preview({ ...source, allowScripts: true });
  const gate = deferred();
  const one = service.attach(
    "s1",
    { source, previewId: first.previewId },
    () => gate.promise,
  );
  const two = service.attach(
    "s1",
    { source: { ...source, allowScripts: true }, previewId: second.previewId },
    () => gate.promise,
  );
  gate.resolve();
  await one;
  await assert.rejects(two, { code: "MCP_PACKAGE_BUSY" });
  assert.equal(records.get("s1").allowScripts, false);
  assert.equal(service.jobs.get("s1").state, "running");
  await service.jobs.idle();
  assert.equal(records.get("s1").allowScripts, false);
  assert.equal(records.get("s1").status, "ready");
});

test("the job log names no data or home path", async (t) => {
  const home = os.homedir();
  const { dataDir, service } = harness(t, {
    ciOutput: (cwd) => `${cwd}\n${fs.realpathSync(cwd)}\n${home}/secret\n`,
  });
  await attach(service);
  await service.jobs.idle();
  const { log } = service.status("s1").job;
  assert.ok(!log.includes(dataDir));
  assert.ok(!log.includes(fs.realpathSync(dataDir)));
  assert.ok(!log.includes(home));
  assert.match(log, /<data>\/mcp-packages\/installs\/\.stage-/);
  assert.match(log, /~\/secret/);
});

const heldAdapter = () => {
  const waiting = [];
  return {
    waiting,
    adapter: {
      toolchainKind: "node",
      versions: async () => ({ latest: null, versions: [] }),
      preview: () =>
        new Promise((resolve) =>
          waiting.push(() =>
            resolve({
              integrity: "sha512-top",
              programs: [{ name: "x", path: "index.js" }],
              needsScripts: false,
              manifestText: "{}",
              lockText: "{}",
              digest: "d",
              dependencies: [],
            }),
          ),
        ),
    },
  };
};

test("at most two previews resolve at once; a third is busy", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-cap-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const held = heldAdapter();
  const service = new McpPackages({
    dataDir,
    servers: { packages: { get: () => null } },
    changes: {},
    toolchain: async () => ({}),
    adapters: { npm: held.adapter },
  });
  const ref = { registry: "npm", name: "x", version: "1.0.0" };
  const first = service.preview(ref);
  const second = service.preview(ref);
  await assert.rejects(service.preview(ref), (error) => {
    assert.equal(error.code, "MCP_PACKAGE_BUSY");
    assert.equal(error.status, 409);
    assert.match(error.message, /Pakete|packages/);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  held.waiting.splice(0).forEach((open) => open());
  await Promise.all([first, second]);
  const third = service.preview(ref);
  await new Promise((resolve) => setImmediate(resolve));
  held.waiting.splice(0).forEach((open) => open());
  assert.equal((await third).programs[0], "x");
});

test("a preview that needs a build is refused for that before its programs", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-needs-build-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const service = new McpPackages({
    dataDir,
    servers: { packages: { get: () => null } },
    changes: {},
    toolchain: async () => ({}),
    adapters: {
      npm: {
        toolchainKind: "node",
        preview: async () => ({
          integrity: "sha256:a",
          installFile: { filename: "x-1.tar.gz", sha256: "a" },
          programs: [],
          needsScripts: true,
          manifestText: "x==1\n",
          lockText: null,
          digest: null,
          dependencies: [],
        }),
      },
    },
  });
  const ref = { registry: "npm", name: "x", version: "1.0.0" };
  const preview = await service.preview(ref);
  assert.deepEqual(preview.programs, []);
  assert.deepEqual(preview.installFile, { filename: "x-1.tar.gz", sha256: "a" });
  assert.throws(() => service.confirmedPreview(preview.previewId, ref), {
    code: "MCP_PACKAGE_NEEDS_SCRIPTS",
  });
});

test("a package without programs at preview gets the program its install names", async (t) => {
  const installed = [];
  const adapter = {
    toolchainKind: "node",
    preview: async ({ toolchain }) => {
      await toolchain();
      return {
        integrity: "sha256:a",
        programs: [],
        needsScripts: false,
        manifestText: "x==1\n",
        lockText: "x==1 --hash=sha256:a\n",
        digest: "d",
        dependencies: [],
      };
    },
    checkStored: () => ({ digest: "d", dependencies: [] }),
    manifestText: () => "x==1\n",
    install: async ({ directory }) => installed.push(directory),
    programsAfterInstall: () => [{ name: "x-server", path: "bin/x-server" }],
    command: (_dataDir, receipt) => ({
      command: "/bin/run",
      leading: [receipt.program.path],
    }),
    toolchainVersion: () => "1.0",
  };
  const { service, records, rows } = harness(t, { adapters: { npm: adapter } });
  const { previewId, programs } = await service.preview(source);
  assert.deepEqual(programs, []);
  await service.attach("s1", { source, previewId });
  assert.equal(records.get("s1").program, "");
  assert.equal(records.get("s1").programPath, "");
  await service.jobs.idle();
  assert.equal(installed.length, 1);
  const row = records.get("s1");
  assert.equal(row.status, "ready");
  assert.equal(row.program, "x-server");
  assert.equal(row.programPath, "bin/x-server");
  assert.equal(rows.get("s1").command, "/bin/run");
  assert.deepEqual(rows.get("s1").args, ["bin/x-server", "--flag"]);
});

/** An adapter whose preview lists no programs; `installs` records each install's preview. */
const lateProgramAdapter = (installs, { needsScripts = false } = {}) => ({
  toolchainKind: "node",
  preview: async () => ({
    integrity: "sha256:a",
    programs: [],
    needsScripts,
    manifestText: "x==1\n",
    lockText: "x==1 --hash=sha256:a\n",
    digest: "d",
    dependencies: [],
  }),
  checkStored: () => ({ digest: "d", dependencies: [] }),
  manifestText: () => "x==1\n",
  install: async ({ preview }) => installs.push(preview),
  programsAfterInstall: () => [{ name: "x-server", path: "x-server" }],
  command: () => ({ command: "/bin/run", leading: [] }),
  toolchainVersion: () => "1.0",
});

test("PyPI is registered by default with its index and the uv cache", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-packages-unit-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const service = new McpPackages({ dataDir, servers: { packages: {} } });
  assert.equal(service.adapterOf("pypi"), pythonAdapter);
  assert.deepEqual(service.registries.pypi, pypiIndexRegistry);
  assert.deepEqual(pypiIndexRegistry, {
    api: "https://pypi.org",
    index: "https://pypi.org/simple",
  });
  assert.equal(service.cacheDir("pypi"), path.join(dataDir, "mcp-packages", ".uv-cache"));
  assert.equal(service.cacheDir("npm"), path.join(dataDir, "mcp-packages", ".npm-cache"));
});

test("a program named before the install must look like a program name", async (t) => {
  const { service } = harness(t, { adapters: { npm: lateProgramAdapter([]) } });
  for (const wanted of ["../x", "-x", "a b", "x/y", "a".repeat(101), 7]) {
    const { previewId } = await service.preview(source);
    assert.throws(() => service.confirmedPreview(previewId, source, wanted), {
      code: "MCP_PACKAGE_INVALID",
    });
  }
  const { previewId } = await service.preview(source);
  assert.equal(
    service.confirmedPreview(previewId, source, "x-server").program.name,
    "x-server",
  );
});

test("the receipt keeps whether a build was needed; reinstall installs the same way", async (t) => {
  const installs = [];
  const { dataDir, service, records } = harness(t, {
    adapters: { npm: lateProgramAdapter(installs) },
  });
  const opted = { ...source, allowScripts: true };
  const { previewId } = await service.preview(opted);
  await service.attach("s1", { source: opted, previewId });
  await service.jobs.idle();
  const row = records.get("s1");
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(dataDir, "mcp-packages", "installs", row.installId, "receipt.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.needsScripts, false);
  service.reinstall("s1");
  await service.jobs.idle();
  assert.equal(installs.at(-1).needsScripts, false);
  // Without a readable receipt the stored record decides, not the owner's opt-in:
  // a wheel-only install stays wheel-only.
  assert.equal(records.get("s1").needsScripts, false);
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs"), { recursive: true });
  service.reinstall("s1");
  await service.jobs.idle();
  assert.equal(installs.at(-1).needsScripts, false);
});
