import test from "node:test";
import assert from "node:assert/strict";
import {
  toolchainManifest as m,
  toolchainTarget,
} from "../../server/features/mcp-packages/toolchain-manifest.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const sha = /^[0-9a-f]{64}$/;

test("every supported target pins Node, uv and CPython with a SHA-256", () => {
  assert.equal(m.node.version, runtimeManifest.nodeVersion);
  assert.equal(m.node.npmVersion, runtimeManifest.npmVersion);
  for (const target of targets) {
    assert.match(m.node.checksums[target], sha, `node ${target}`);
    assert.match(m.uv.checksums[target], sha, `uv ${target}`);
    assert.match(m.python.checksums[target], sha, `python ${target}`);
  }
  assert.deepEqual(Object.keys(m.uv.checksums).sort(), targets);
  assert.deepEqual(Object.keys(m.python.checksums).sort(), targets);
});

test("download URLs name the pinned versions and official hosts", () => {
  assert.equal(
    m.uv.url("linux-x64"),
    "https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-unknown-linux-gnu.tar.gz",
  );
  assert.equal(
    m.python.asset("darwin-arm64"),
    "cpython-3.14.7+20260929-aarch64-apple-darwin-install_only_stripped.tar.gz",
  );
  assert.equal(
    m.python.url("darwin-arm64"),
    "https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-apple-darwin-install_only_stripped.tar.gz",
  );
});

test("the target check refuses musl, Windows and unknown architectures", () => {
  assert.equal(toolchainTarget({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(
    toolchainTarget({ platform: "linux", arch: "x64", glibc: "2.39" }),
    "linux-x64",
  );
  for (const host of [
    { platform: "linux", arch: "x64", glibc: null },
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "ppc64", glibc: "2.39" },
  ])
    assert.throws(
      () => toolchainTarget(host),
      (error) => error.code === "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
      JSON.stringify(host),
    );
});
