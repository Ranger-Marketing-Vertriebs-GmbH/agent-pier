import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { resolveNpm } from "../../server/features/mcp-packages/npm-package-install.js";
import {
  createFrozenServer,
  installFrozen,
  jobSettled,
} from "../../server/features/mcp-packages/frozen-install.js";
import { placeFridaPrebuild } from "../../server/features/tools/rea-frida.js";
import {
  createPackaged,
  installsOf,
  packageService,
} from "../helpers/mcp-packages-service.js";
import { tarGz } from "../helpers/tar-fixture.js";

const fakeBinding = "fake-frida-binding";
const rea = (version) => ({
  name: "rea-agents",
  version,
  bin: { rea: "scripts/rea.mjs" },
  files: { "scripts/rea.mjs": "" },
  optionalDependencies: { frida: "17.23.2" },
});
const frida = {
  name: "frida",
  version: "17.23.2",
  type: "module",
  main: "build/src/frida.js",
  exports: { ".": "./build/src/frida.js" },
  scripts: {
    install: "node -e \"require('fs').writeFileSync('install-marker','ran')\"",
  },
  files: {
    // Needs the binding, as the real package does.
    "build/src/frida.js": `import fs from "node:fs";
const binding = new URL("../frida_binding.node", import.meta.url);
if (fs.readFileSync(binding, "utf8") !== ${JSON.stringify(fakeBinding)}) throw Error("x");
export function getDeviceManager() {}
`,
  },
};
const program = { name: "rea", path: "scripts/rea.mjs" };
const managed = { tool: "rea", lockedEnv: ["REA_MCP_INPUT_SCHEMA_PROFILE"] };
const bindingOf = (dataDir, installId) =>
  path.join(
    dataDir,
    "mcp-packages",
    "installs",
    installId,
    "node_modules",
    "frida",
    "build",
    "frida_binding.node",
  );

/** A local stand-in for github.com: fetchImpl rewrites https://host/path to it. */
async function prebuildHost(t, bytes) {
  const server = http.createServer((req, res) => {
    if (req.url !== "/github.com/frida/frida/releases/download/17.23.2/p.tar.gz")
      return res.writeHead(404).end();
    res.setHeader("content-length", bytes.length);
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return (url, init) => fetch(`${base}/${url.replace(/^https:\/\//, "")}`, init);
}

/** The pinned prebuild entry for `content`, served by a local host. */
async function prebuild(t, content = fakeBinding) {
  const bytes = tarGz([{ name: "build/frida_binding.node", content }]);
  const fetchImpl = await prebuildHost(t, bytes);
  const entry = {
    url: "https://github.com/frida/frida/releases/download/17.23.2/p.tar.gz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  return { entry, fetchImpl };
}

async function reaService(t) {
  const s = await packageService(t, [rea("6.8.0"), rea("6.9.0"), frida]);
  const { entry, fetchImpl } = await prebuild(t);
  const hooked = [];
  const useFrida = (fridaEntry = entry) => {
    s.packages.afterInstall = async (serverId, context) => {
      hooked.push({
        serverId,
        status: s.servers.packages.get(serverId)?.status,
        installs: installsOf(s.dataDir),
      });
      await placeFridaPrebuild({ ...context, entry: fridaEntry, fetchImpl });
      hooked.at(-1).placed = fs.existsSync(
        path.join(context.directory, "node_modules/frida/build/frida_binding.node"),
      );
    };
  };
  // The "committed" lock, resolved the same way scripts/refresh-rea-lock.mjs does.
  const frozen = async (version) => {
    const stage = fs.mkdtempSync(path.join(s.dataDir, "resolve-"));
    const ref = { registry: "npm", name: "rea-agents", version };
    const { lockText } = await resolveNpm({
      stage,
      ref,
      node: s.node,
      registry: s.registry.url,
      cacheDir: path.join(s.dataDir, "lock-cache"),
      environment: {},
    });
    fs.rmSync(stage, { recursive: true, force: true });
    return { ref, lockText, integrity: s.registry.integrity("rea-agents", version) };
  };
  const create = async (lock) => {
    const server = await createFrozenServer(
      s.packages,
      { name: "rea-agentpier", transport: "stdio", args: ["mcp"], env: {} },
      { clis: ["claude"], frozen: lock, program, managed },
    );
    await jobSettled(s.packages, server.id);
    return server;
  };
  return { s, entry, hooked, useFrida, frozen, create };
}

test("createFrozenServer stores a managed row and installs the frozen lock without scripts", async (t) => {
  const { s, frozen, create } = await reaService(t);
  const created = await create(await frozen("6.8.0"));
  assert.equal(created.managed.tool, "rea");
  const server = s.servers.get(created.id);
  const row = s.servers.packages.get(created.id);
  assert.equal(row.status, "ready");
  assert.equal(row.allowScripts, false);
  assert.equal(s.packages.jobs.get(created.id).state, "done");
  assert.equal(server.managed.tool, "rea");
  assert.deepEqual(server.managed.lockedEnv, ["REA_MCP_INPUT_SCHEMA_PROFILE"]);
  assert.equal(server.command, s.node.nodePath);
  assert.deepEqual(server.args, [
    path.join(
      s.dataDir,
      "mcp-packages",
      "installs",
      row.installId,
      "node_modules",
      "rea-agents",
      "scripts",
      "rea.mjs",
    ),
    "mcp",
  ]);
  const fridaDir = path.dirname(path.dirname(bindingOf(s.dataDir, row.installId)));
  assert.equal(fs.statSync(fridaDir).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(fridaDir, "install-marker")), false);
  const ci = s.calls.find((args) => args.includes("ci"));
  assert.ok(ci.includes("--ignore-scripts"));
  // No hook assigned: no binding, no load check.
  assert.equal(fs.existsSync(bindingOf(s.dataDir, row.installId)), false);
  assert.equal(
    s.calls.some((args) => args.includes("--input-type=module")),
    false,
  );
});

test("the afterInstall hook places the Frida binding before the install is committed", async (t) => {
  const { s, hooked, useFrida, frozen, create } = await reaService(t);
  useFrida();
  const server = await create(await frozen("6.8.0"));
  const row = s.servers.packages.get(server.id);
  assert.equal(row.status, "ready");
  assert.equal(hooked.length, 1);
  assert.equal(hooked[0].serverId, server.id);
  assert.equal(hooked[0].status, "installing");
  assert.equal(hooked[0].placed, true);
  // The stage is not committed yet while the hook runs.
  assert.ok(hooked[0].installs.every((name) => name.startsWith(".stage-")));
  const binding = bindingOf(s.dataDir, row.installId);
  assert.equal(fs.statSync(binding).isFile(), true);
  assert.equal(fs.statSync(binding).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(binding, "utf8"), fakeBinding);
  const install = path.dirname(path.dirname(path.dirname(path.dirname(binding))));
  assert.equal(fs.existsSync(path.join(install, ".frida-work")), false);
  const check = s.calls.find((args) => args.includes("--input-type=module"));
  // The managed Node loaded frida from the stage, before the commit renamed it.
  assert.equal(check.at(-1), path.join(path.dirname(install), `.stage-${row.installId}`));
});

test("a wrong Frida checksum fails the job and the server keeps its previous install", async (t) => {
  const { s, entry, useFrida, frozen, create } = await reaService(t);
  useFrida();
  const lock = await frozen("6.8.0");
  const server = await create(lock);
  const before = s.servers.packages.get(server.id);
  const args = s.servers.get(server.id).args;
  useFrida({ ...entry, sha256: "0".repeat(64) });
  installFrozen(s.packages, server.id, lock, program, "reinstall");
  await jobSettled(s.packages, server.id);
  const job = s.packages.jobs.get(server.id);
  assert.equal(job.state, "failed");
  assert.equal(job.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(s.packages.jobs.failureMessage(server.id), serverMessages.rea.fridaFailed);
  const after = s.servers.packages.get(server.id);
  assert.equal(after.installId, before.installId);
  assert.equal(after.status, "ready");
  assert.deepEqual(s.servers.get(server.id).args, args);
  assert.deepEqual(installsOf(s.dataDir), [before.installId]);
  assert.equal(fs.statSync(bindingOf(s.dataDir, before.installId)).isFile(), true);
});

test("a binding that does not load fails the job before the install is committed", async (t) => {
  const { s, frozen } = await reaService(t);
  const { entry, fetchImpl } = await prebuild(t, "other");
  s.packages.afterInstall = (_id, context) =>
    placeFridaPrebuild({ ...context, entry, fetchImpl });
  const server = await createFrozenServer(
    s.packages,
    { name: "rea-agentpier", transport: "stdio", args: ["mcp"], env: {} },
    { frozen: await frozen("6.8.0"), program, managed },
  );
  await jobSettled(s.packages, server.id);
  assert.equal(s.packages.jobs.get(server.id).state, "failed");
  assert.equal(s.packages.jobs.failureMessage(server.id), serverMessages.rea.fridaFailed);
  assert.equal(s.servers.packages.get(server.id).status, "failed");
  assert.deepEqual(installsOf(s.dataDir), []);
});

test("a lock that does not match the pinned integrity is refused before npm runs", async (t) => {
  const { s, frozen } = await reaService(t);
  const lock = await frozen("6.8.0");
  await assert.rejects(
    createFrozenServer(
      s.packages,
      { name: "rea-agentpier", transport: "stdio", args: ["mcp"], env: {} },
      {
        frozen: { ...lock, integrity: s.registry.integrity("rea-agents", "6.9.0") },
        program,
        managed,
      },
    ),
    { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" },
  );
  assert.equal(
    s.calls.some((args) => args.includes("ci")),
    false,
  );
  assert.deepEqual(s.servers.definitions(), []);
});

test("installFrozen 'update' switches to a new lock and prunes the old install", async (t) => {
  const { s, frozen, create } = await reaService(t);
  const server = await create(await frozen("6.8.0"));
  const old = s.servers.packages.get(server.id).installId;
  const next = await frozen("6.9.0");
  installFrozen(s.packages, server.id, next, program, "update");
  assert.equal(s.packages.jobs.get(server.id).kind, "update");
  await jobSettled(s.packages, server.id);
  const row = s.servers.packages.get(server.id);
  assert.equal(row.status, "ready");
  assert.equal(row.version, "6.9.0");
  assert.equal(row.lock, next.lockText);
  assert.notEqual(row.installId, old);
  assert.deepEqual(installsOf(s.dataDir), [row.installId]);
  const args = s.servers.get(server.id).args;
  assert.ok(args[0].includes(row.installId));
  assert.equal(args[1], "mcp");
  assert.equal(s.servers.get(server.id).managed.tool, "rea");
});

test("installFrozen 'reinstall' without the hook leaves no binding (Frida off)", async (t) => {
  const { s, useFrida, frozen, create } = await reaService(t);
  useFrida();
  const lock = await frozen("6.8.0");
  const server = await create(lock);
  const first = s.servers.packages.get(server.id).installId;
  assert.equal(fs.existsSync(bindingOf(s.dataDir, first)), true);
  s.packages.afterInstall = null;
  installFrozen(s.packages, server.id, lock, program, "reinstall");
  await jobSettled(s.packages, server.id);
  const row = s.servers.packages.get(server.id);
  assert.equal(s.packages.jobs.get(server.id).state, "done");
  assert.notEqual(row.installId, first);
  assert.equal(fs.existsSync(bindingOf(s.dataDir, row.installId)), false);
  assert.equal(
    fs
      .statSync(path.dirname(path.dirname(bindingOf(s.dataDir, row.installId))))
      .isDirectory(),
    true,
  );
});

test("installFrozen refuses a server without a record of the same package", async (t) => {
  const { s, frozen } = await reaService(t);
  const lock = await frozen("6.8.0");
  assert.throws(() => installFrozen(s.packages, "missing", lock, program, "update"), {
    code: "MCP_PACKAGE_INVALID",
  });
});

test("a deleted managed row cancels its running frozen install", async (t) => {
  const { s, useFrida, frozen } = await reaService(t);
  useFrida();
  const lock = await frozen("6.8.0");
  const held = s.hold();
  const server = await createFrozenServer(
    s.packages,
    { name: "rea-agentpier", transport: "stdio", args: ["mcp"], env: {} },
    { clis: ["claude"], frozen: lock, program, managed },
  );
  await held.reached;
  await s.changes.remove(server.id);
  held.release();
  await jobSettled(s.packages, server.id);
  assert.equal(s.packages.jobs.get(server.id).state, "cancelled");
  await s.packages.prune();
  assert.deepEqual(installsOf(s.dataDir), []);
  assert.equal(s.servers.packages.get(server.id), null);
  assert.equal(s.servers.managed.get(server.id), null);
  // jobSettled never rejects, also for a server without a job.
  await jobSettled(s.packages, "missing");
});

test("other packages install unchanged and an unset hook is skipped", async (t) => {
  const s = await packageService(t);
  assert.equal(s.packages.afterInstall, null);
  const { server } = await createPackaged(s);
  await s.packages.jobs.idle();
  assert.equal(s.servers.packages.get(server.id).status, "ready");
  assert.equal(
    s.calls.some((args) => args.includes("--input-type=module")),
    false,
  );
});

/** A bare install folder with the fake frida package, as `npm ci` leaves it. */
function fakeInstall(t, { linkFrida = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-frida-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "install");
  const real = path.join(
    linkFrida ? root : path.join(directory, "node_modules"),
    "frida",
  );
  fs.mkdirSync(path.join(real, "build", "src"), { recursive: true });
  fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  if (linkFrida) fs.symlinkSync(real, path.join(directory, "node_modules", "frida"));
  fs.writeFileSync(path.join(directory, "package.json"), "{}");
  const { files, ...manifest } = frida;
  fs.writeFileSync(path.join(real, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(real, "build/src/frida.js"), files["build/src/frida.js"]);
  return { directory, real };
}

test("placeFridaPrebuild loads frida with the given Node through its own runner", async (t) => {
  const { entry, fetchImpl } = await prebuild(t);
  const { directory } = fakeInstall(t);
  await placeFridaPrebuild({
    directory,
    entry,
    toolchain: { nodePath: process.execPath },
    fetchImpl,
  });
  const target = path.join(directory, "node_modules/frida/build/frida_binding.node");
  assert.equal(fs.readFileSync(target, "utf8"), fakeBinding);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["node_modules", "package.json"]);
});

test("placeFridaPrebuild never writes through a linked frida folder", async (t) => {
  const { entry, fetchImpl } = await prebuild(t);
  const { directory, real } = fakeInstall(t, { linkFrida: true });
  const logged = [];
  await assert.rejects(
    placeFridaPrebuild({
      directory,
      entry,
      toolchain: { nodePath: process.execPath },
      fetchImpl,
      log: (text) => logged.push(text),
    }),
    { code: "MCP_PACKAGE_INSTALL_FAILED", message: serverMessages.rea.fridaFailed },
  );
  assert.equal(fs.existsSync(path.join(real, "build", "frida_binding.node")), false);
  assert.equal(fs.existsSync(path.join(directory, ".frida-work")), false);
  assert.deepEqual(logged, []);
});
