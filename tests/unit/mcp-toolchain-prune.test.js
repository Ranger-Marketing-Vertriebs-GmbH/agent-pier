import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toolchainFixture } from "../helpers/toolchain-fixture.js";
import { acquireInstallLock } from "../../server/features/assistants/runtime-install-lock.js";
import {
  ensureToolchain,
  pruneToolchains,
  toolchainRoot,
} from "../../server/features/mcp-packages/toolchains.js";

const host = { platform: "darwin", arch: "arm64" };
const stale = [
  "node-v24.1.0-darwin-arm64",
  "python-3.13.1+20250101-uv0.9.0-darwin-arm64",
  "python-3.14.1+20260101-uv0.12.0-darwin-arm64",
];
async function installed(t) {
  const f = toolchainFixture(t);
  const opts = {
    dataDir: f.dataDir,
    ...host,
    download: f.download,
    manifest: f.manifest,
  };
  const node = await ensureToolchain("node", opts);
  const python = await ensureToolchain("python", opts);
  const root = toolchainRoot(f.dataDir);
  for (const name of [...stale, "node-v24.1.0-linux-x64", "notes"])
    fs.mkdirSync(path.join(root, name, "bin"), { recursive: true });
  return { f, node, python, root, opts: { ...host, manifest: f.manifest } };
}
const listed = (root) => fs.readdirSync(root).sort();

test("pruning keeps the pinned and in-use toolchains and removes stale ones", async (t) => {
  const { f, node, python, root, opts } = await installed(t);
  const inUse = new Set([path.join(root, stale[1])]);
  const removed = await pruneToolchains(f.dataDir, inUse, opts);
  assert.deepEqual(removed.sort(), [stale[0], stale[2]]);
  assert.deepEqual(
    listed(root),
    [
      "node-v24.1.0-linux-x64",
      path.basename(node.directory),
      "notes",
      path.basename(python.directory),
      stale[1],
    ].sort(),
  );
});

test("pruning accepts paths inside an in-use toolchain", async (t) => {
  const { f, root, opts } = await installed(t);
  const inUse = [path.join(root, stale[0], "bin", "node")];
  const removed = await pruneToolchains(f.dataDir, inUse, opts);
  assert.deepEqual(removed.sort(), [stale[1], stale[2]]);
});

test("pruning while another install holds the lock removes nothing", async (t) => {
  const { f, root, opts } = await installed(t);
  const before = listed(root);
  const release = acquireInstallLock({ runtimes: root });
  try {
    assert.deepEqual(await pruneToolchains(f.dataDir, [], opts), []);
  } finally {
    release();
  }
  assert.deepEqual(listed(root), before);
});

test("an unresolvable in-use entry disables pruning entirely", async (t) => {
  const { f, root, opts } = await installed(t);
  const before = listed(root);
  for (const entry of [null, 7, "", f.dataDir, "/elsewhere/node", path.join(root, "..")])
    assert.deepEqual(
      await pruneToolchains(f.dataDir, [path.join(root, stale[0]), entry], opts),
      [],
      String(entry),
    );
  assert.deepEqual(listed(root), before);
});

test("pruning without any toolchains is a no-op", async (t) => {
  const f = toolchainFixture(t);
  assert.deepEqual(await pruneToolchains(f.dataDir, [], host), []);
  assert.equal(fs.existsSync(toolchainRoot(f.dataDir)), false);
});

test("pruning waits for an install in this process instead of skipping", async (t) => {
  const f = toolchainFixture(t);
  const opts = {
    dataDir: f.dataDir,
    ...host,
    download: f.download,
    manifest: f.manifest,
  };
  await ensureToolchain("node", opts);
  const root = toolchainRoot(f.dataDir);
  fs.mkdirSync(path.join(root, stale[0]));
  let started, open;
  const downloading = new Promise((resolve) => (started = resolve));
  const gate = new Promise((resolve) => (open = resolve));
  const held = async (url) => {
    started();
    await gate;
    return f.download(url);
  };
  const python = ensureToolchain("python", { ...opts, download: held });
  await downloading;
  const pruned = pruneToolchains(f.dataDir, [], { ...host, manifest: f.manifest });
  open();
  await python;
  assert.deepEqual(await pruned, [stale[0]]);
});

test("pruning refuses a linked or non-folder toolchain root", async (t) => {
  const { f, root, opts } = await installed(t);
  const moved = path.join(f.root, "moved");
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root);
  const before = listed(moved);
  assert.deepEqual(await pruneToolchains(f.dataDir, [], opts), []);
  assert.deepEqual(listed(moved), before);
  fs.rmSync(root);
  fs.writeFileSync(root, "");
  assert.deepEqual(await pruneToolchains(f.dataDir, [], opts), []);
});

test("an unresolvable in-use entry (null) disables pruning", async (t) => {
  const { f, root, opts } = await installed(t);
  const before = listed(root);
  assert.deepEqual(await pruneToolchains(f.dataDir, [null], opts), []);
  assert.deepEqual(listed(root), before);
});
