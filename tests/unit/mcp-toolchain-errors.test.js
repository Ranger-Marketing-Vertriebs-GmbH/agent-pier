import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toolchainFixture } from "../helpers/toolchain-fixture.js";
import { acquireInstallLock } from "../../server/features/assistants/runtime-install-lock.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  ensureToolchain,
  pruneToolchains,
  toolchainRoot,
} from "../../server/features/mcp-packages/toolchains.js";

const options = (f) => ({
  dataDir: f.dataDir,
  platform: "darwin",
  arch: "arm64",
  download: f.download,
  manifest: f.manifest,
});
const failure = (promise) =>
  promise.then(
    () => assert.fail("resolved"),
    (e) => e,
  );
function assertCoded(error, code, f) {
  assert.equal(error.code, code, error.message);
  assert.equal(error.message.includes(f.root), false, error.message);
  assert.equal(error.message.includes(fs.realpathSync(f.root)), false, error.message);
}

test("unsafe toolchain storage is a coded error without a path", async (t) => {
  const f = toolchainFixture(t);
  const elsewhere = path.join(f.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, toolchainRoot(f.dataDir));
  const error = await failure(ensureToolchain("node", options(f)));
  assertCoded(error, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", f);
  assert.equal(f.downloads.length, 0);
});

test("a stage that cannot be cleared is MCP_PACKAGE_INSTALL_FAILED without a path", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores folder permissions");
  const f = toolchainFixture(t);
  const locked = path.join(toolchainRoot(f.dataDir), ".stage-old", "locked");
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, "file"), "");
  fs.chmodSync(locked, 0o500);
  try {
    const error = await failure(ensureToolchain("node", options(f)));
    assertCoded(error, "MCP_PACKAGE_INSTALL_FAILED", f);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("an unusable install lock is unavailable, not busy", async (t) => {
  const f = toolchainFixture(t);
  fs.mkdirSync(path.join(toolchainRoot(f.dataDir), ".install.lock"), { recursive: true });
  const error = await failure(ensureToolchain("node", options(f)));
  assertCoded(error, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", f);
  const pruned = await failure(pruneToolchains(f.dataDir, [], options(f)));
  assertCoded(pruned, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", f);
});

test("a toolchain install held elsewhere is busy in neutral words", async (t) => {
  const f = toolchainFixture(t);
  fs.mkdirSync(toolchainRoot(f.dataDir));
  const release = acquireInstallLock({ runtimes: toolchainRoot(f.dataDir) });
  t.after(release);
  const error = await failure(ensureToolchain("python", options(f)));
  assert.equal(error.code, "MCP_PACKAGE_BUSY");
  assert.equal(error.status, 409);
  assert.equal(typeof serverMessages.mcpPackages.toolchainBusy, "string");
  assert.equal(error.message, serverMessages.mcpPackages.toolchainBusy);
  assert.doesNotMatch(error.message, /Server/i);
});
