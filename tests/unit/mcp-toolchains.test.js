import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { toolchainFixture } from "../helpers/toolchain-fixture.js";
import { acquireInstallLock } from "../../server/features/assistants/runtime-install-lock.js";
import {
  ensureToolchain,
  nodeDirectory,
  pythonDirectory,
  readToolchain,
  toolchainPaths,
  toolchainRoot,
} from "../../server/features/mcp-packages/toolchains.js";

const options = (f, extra = {}) => ({
  dataDir: f.dataDir,
  platform: "darwin",
  arch: "arm64",
  download: f.download,
  manifest: f.manifest,
  ...extra,
});
const unavailable = { code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" };
const stages = (dataDir) =>
  fs.readdirSync(toolchainRoot(dataDir)).filter((name) => name.startsWith(".stage"));
function tree(directory) {
  return fs
    .readdirSync(directory, { recursive: true })
    .map((name) => path.basename(String(name)));
}

test("toolchain directories are named after the pinned versions and target", (t) => {
  const f = toolchainFixture(t);
  const root = toolchainRoot(f.dataDir);
  assert.equal(root, path.join(f.dataDir, "toolchains"));
  assert.equal(fs.existsSync(root), false);
  assert.equal(toolchainPaths(f.dataDir).root, root);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(
    nodeDirectory(f.dataDir, "linux-x64"),
    path.join(root, "node-v26.7.0-linux-x64"),
  );
  assert.equal(
    pythonDirectory(f.dataDir, "linux-x64"),
    path.join(root, "python-3.14.7+20260929-uv0.12.21-linux-x64"),
  );
});

test("node toolchain installs once, verifies and is read back without downloads", async (t) => {
  const f = toolchainFixture(t);
  assert.equal(readToolchain("node", options(f)), null);
  const node = await ensureToolchain("node", options(f));
  assert.equal(node.kind, "node");
  assert.equal(node.version, "26.7.0");
  assert.equal(execFileSync(node.nodePath).toString().trim(), "v26.7.0");
  assert.ok(node.npmCliPath.endsWith("lib/node_modules/npm/bin/npm-cli.js"));
  assert.deepEqual(readToolchain("node", options(f)), node);
  const again = await ensureToolchain("node", options(f));
  assert.deepEqual(again, node);
  assert.deepEqual(f.downloads, [f.manifest.node.url(f.target)]);
  assert.deepEqual(stages(f.dataDir), []);
});

test("python toolchain installs CPython only from the verified mirror", async (t) => {
  const f = toolchainFixture(t);
  const python = await ensureToolchain("python", options(f));
  assert.equal(python.kind, "python");
  assert.equal(python.uvVersion, "0.12.21");
  assert.equal(python.pythonVersion, "3.14.7");
  assert.equal(execFileSync(python.pythonPath).toString().trim(), "Python 3.14.7");
  assert.ok(python.pythonPath.startsWith(python.directory + path.sep));
  assert.deepEqual(readToolchain("python", options(f)), python);
  // The mirror and the downloaded archive stay in the stage, which is removed.
  const names = tree(python.directory);
  assert.equal(names.includes("mirror"), false);
  assert.equal(names.includes(f.manifest.python.asset(f.target)), false);
  assert.deepEqual(stages(f.dataDir), []);
});

test("a corrupt download leaves nothing behind and keeps the code stable", async (t) => {
  const f = toolchainFixture(t);
  const corrupt = async () => Buffer.from("corrupt");
  await assert.rejects(ensureToolchain("node", options(f, { download: corrupt })), {
    code: "MCP_PACKAGE_DOWNLOAD_FAILED",
  });
  assert.equal(readToolchain("node", options(f)), null);
  assert.deepEqual(fs.readdirSync(toolchainRoot(f.dataDir)), []);
});

test("an unreachable download reports MCP_PACKAGE_DOWNLOAD_FAILED", async (t) => {
  const f = toolchainFixture(t);
  const offline = async () => {
    throw Object.assign(Error("offline /secret/path"), { status: 502 });
  };
  const error = await ensureToolchain("python", options(f, { download: offline })).catch(
    (e) => e,
  );
  assert.equal(error.code, "MCP_PACKAGE_DOWNLOAD_FAILED");
  assert.doesNotMatch(error.message, /secret/);
});

test("a failing uv install reports MCP_PACKAGE_INSTALL_FAILED without output", async (t) => {
  const f = toolchainFixture(t);
  const run = promisify(execFile);
  const execute = (file, args, opts) =>
    args[0] === "python"
      ? Promise.reject(Error(`uv failed in ${file}`))
      : run(file, args, opts);
  const error = await ensureToolchain("python", options(f, { execute })).catch((e) => e);
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.doesNotMatch(error.message, /uv failed/);
  assert.equal(readToolchain("python", options(f)), null);
  assert.deepEqual(fs.readdirSync(toolchainRoot(f.dataDir)), []);
});

test("a tampered installation is refused, not used", async (t) => {
  const f = toolchainFixture(t);
  const node = await ensureToolchain("node", options(f));
  fs.rmSync(node.nodePath);
  fs.symlinkSync("/bin/sh", node.nodePath);
  assert.throws(() => readToolchain("node", options(f)), unavailable);
  await assert.rejects(ensureToolchain("node", options(f)), unavailable);
});

test("an edited, malformed or missing receipt is refused", async (t) => {
  const f = toolchainFixture(t);
  const node = await ensureToolchain("node", options(f));
  const python = await ensureToolchain("python", options(f));
  const nodeReceipt = path.join(node.directory, "receipt.json");
  const pythonReceipt = path.join(python.directory, "receipt.json");
  const original = JSON.parse(fs.readFileSync(pythonReceipt, "utf8"));
  const edits = [
    [nodeReceipt, JSON.stringify({ kind: "node", target: f.target, checksum: "0" })],
    [nodeReceipt, "{ not json"],
    [nodeReceipt, "null"],
    [pythonReceipt, JSON.stringify({ ...original, pythonPath: 7 })],
    [pythonReceipt, JSON.stringify({ ...original, pythonPath: "../../../bin/sh" })],
    [pythonReceipt, JSON.stringify({ ...original, pythonVersion: "3.99.0" })],
    [pythonReceipt, JSON.stringify({ ...original, kind: "node" })],
  ];
  for (const [file, text] of edits) {
    const kind = file === nodeReceipt ? "node" : "python";
    const before = fs.readFileSync(file);
    fs.writeFileSync(file, text);
    assert.throws(() => readToolchain(kind, options(f)), unavailable, text);
    fs.writeFileSync(file, before);
    assert.ok(readToolchain(kind, options(f)));
  }
  fs.rmSync(nodeReceipt);
  assert.throws(() => readToolchain("node", options(f)), unavailable);
});

test("an extra hard link to an installed program is refused on read", async (t) => {
  const f = toolchainFixture(t);
  const node = await ensureToolchain("node", options(f));
  fs.linkSync(node.nodePath, path.join(f.root, "second-name"));
  assert.throws(() => readToolchain("node", options(f)), unavailable);
});

test("a linked toolchain directory or parent folder is refused on read", async (t) => {
  const f = toolchainFixture(t);
  const node = await ensureToolchain("node", options(f));
  const elsewhere = path.join(f.root, "elsewhere");
  fs.cpSync(path.join(node.directory, "bin"), elsewhere, { recursive: true });
  fs.rmSync(path.join(node.directory, "bin"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(node.directory, "bin"));
  assert.throws(() => readToolchain("node", options(f)), unavailable);

  const g = toolchainFixture(t);
  const moved = path.join(g.root, "moved");
  const python = await ensureToolchain("python", options(g));
  fs.renameSync(python.directory, moved);
  fs.symlinkSync(moved, python.directory);
  assert.throws(() => readToolchain("python", options(g)), unavailable);
});

test("musl hosts fail before any download", async (t) => {
  const f = toolchainFixture(t);
  await assert.rejects(
    ensureToolchain("node", options(f, { platform: "linux", arch: "x64", glibc: null })),
    unavailable,
  );
  await assert.rejects(ensureToolchain("ruby", options(f)), unavailable);
  assert.equal(f.downloads.length, 0);
});

test("an interrupted stage is neither used nor blocking and is removed", async (t) => {
  const f = toolchainFixture(t);
  const stale = path.join(toolchainPaths(f.dataDir).root, ".stage-stale");
  const fake = path.join(stale, "node", "bin", "node");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, "#!/bin/sh\necho stale\n", { mode: 0o755 });
  assert.equal(readToolchain("node", options(f)), null);
  const node = await ensureToolchain("node", options(f));
  assert.equal(execFileSync(node.nodePath).toString().trim(), "v26.7.0");
  assert.equal(f.downloads.length, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(stages(f.dataDir), []);
});

test("concurrent ensures of one kind install once", async (t) => {
  const f = toolchainFixture(t);
  const [a, b] = await Promise.all([
    ensureToolchain("node", options(f)),
    ensureToolchain("node", options(f)),
  ]);
  assert.deepEqual(a, b);
  assert.equal(f.downloads.length, 1);
});

test("concurrent ensures of both kinds in one process both install", async (t) => {
  const f = toolchainFixture(t);
  const [node, python] = await Promise.all([
    ensureToolchain("node", options(f)),
    ensureToolchain("python", options(f)),
  ]);
  assert.deepEqual(readToolchain("node", options(f)), node);
  assert.deepEqual(readToolchain("python", options(f)), python);
  assert.equal(f.downloads.length, 3);
});

test("an install lock held elsewhere reports MCP_PACKAGE_BUSY", async (t) => {
  const f = toolchainFixture(t);
  const release = acquireInstallLock({ runtimes: toolchainPaths(f.dataDir).root });
  try {
    await assert.rejects(ensureToolchain("node", options(f)), {
      code: "MCP_PACKAGE_BUSY",
      status: 409,
    });
    assert.equal(f.downloads.length, 0);
  } finally {
    release();
  }
  const node = await ensureToolchain("node", options(f));
  // An installed toolchain is read without waiting for the lock.
  const again = acquireInstallLock({ runtimes: toolchainRoot(f.dataDir) });
  try {
    assert.deepEqual(await ensureToolchain("node", options(f)), node);
  } finally {
    again();
  }
});
