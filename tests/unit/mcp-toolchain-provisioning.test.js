import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  provisionInstallerToolchains,
  stageToolchainsInBackground,
  toolchainStagingDue,
} from "../../server/features/mcp-packages/toolchain-provisioning.js";
import { toolchainRoot } from "../../server/features/mcp-packages/toolchains.js";

const mac = { platform: "darwin", arch: "arm64" };
const dataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-provision-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("installer provisioning reports each toolchain and never throws", async (t) => {
  const calls = [];
  const result = await provisionInstallerToolchains(
    { dataDir: dataDir(t), ...mac },
    {
      ensure: async (kind) => {
        calls.push(kind);
        if (kind === "python")
          throw Object.assign(Error("/private/path"), {
            code: "MCP_PACKAGE_DOWNLOAD_FAILED",
          });
        return { kind, version: "26.7.0" };
      },
    },
  );
  assert.deepEqual(calls, ["node", "python"]);
  assert.deepEqual(result, {
    node: { status: "ready", version: "26.7.0" },
    python: { status: "failed", code: "MCP_PACKAGE_DOWNLOAD_FAILED" },
  });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("an unexpected error is reported with a generic code", async (t) => {
  const result = await provisionInstallerToolchains(
    { dataDir: dataDir(t), ...mac },
    { ensure: async () => Promise.reject(Error("EACCES /secret")) },
  );
  assert.equal(result.node.code, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("musl and unsupported targets report unavailable without touching the data directory", async (t) => {
  for (const target of [
    { platform: "linux", arch: "x64", glibc: null },
    { platform: "freebsd", arch: "x64" },
  ]) {
    const dir = dataDir(t);
    const result = await provisionInstallerToolchains(
      { dataDir: dir, ...target },
      {
        ensure: async () => {
          throw Error("must not be called");
        },
      },
    );
    const failed = { status: "failed", code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" };
    assert.deepEqual(result, { node: failed, python: failed });
    assert.equal(fs.existsSync(toolchainRoot(dir)), false);
  }
});

test("background staging runs only for kinds with an older toolchain", async (t) => {
  const dir = dataDir(t);
  assert.deepEqual(toolchainStagingDue(dir), { node: false, python: false });
  assert.equal(await stageToolchainsInBackground({ dataDir: dir }), null);
  fs.mkdirSync(path.join(toolchainRoot(dir), "node-v26.1.0-darwin-arm64"), {
    recursive: true,
  });
  const due = toolchainStagingDue(dir, undefined, mac);
  assert.deepEqual(due, { node: true, python: false });
  const staged = [];
  await stageToolchainsInBackground(
    { dataDir: dir, ...mac },
    { ensure: async (kind) => staged.push(kind) },
  );
  assert.deepEqual(staged, ["node"]);
});

test("background staging never rejects and logs only a code", async (t) => {
  const dir = dataDir(t);
  fs.mkdirSync(path.join(toolchainRoot(dir), "node-v26.1.0-darwin-arm64"), {
    recursive: true,
  });
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const result = await stageToolchainsInBackground(
    { dataDir: dir, ...mac },
    { ensure: async () => Promise.reject(Error("EACCES /secret")) },
  );
  assert.deepEqual(result, { staged: ["node"] });
  assert.match(logged.join("\n"), /MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE/);
  assert.doesNotMatch(logged.join("\n"), /secret/);
});
