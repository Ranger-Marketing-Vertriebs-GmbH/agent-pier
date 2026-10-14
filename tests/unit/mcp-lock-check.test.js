import test from "node:test";
import assert from "node:assert/strict";
import { checkNpmLock, lockDiff } from "../../server/features/mcp-packages/lock-check.js";

const registry = "https://registry.npmjs.org";
const ref = { registry: "npm", name: "server-x", version: "1.1.0" };
const entry = (name, version, extra = {}) => ({
  version,
  resolved: `${registry}/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}`,
  ...extra,
});
const lock = (packages) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "server-x": "1.1.0" } },
      "node_modules/server-x": entry("server-x", "1.1.0"),
      ...packages,
    },
  });

test("a registry-only lock yields its dependencies and digest", () => {
  const text = lock({ "node_modules/zod": entry("zod", "3.0.0") });
  const result = checkNpmLock(text, { ref, integrity: "sha512-server-x", registry });
  assert.equal(result.needsScripts, false);
  assert.deepEqual(result.dependencies, [
    { name: "server-x", version: "1.1.0" },
    { name: "zod", version: "3.0.0" },
  ]);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("install scripts anywhere in the graph are reported", () => {
  const text = lock({
    "node_modules/esbuild": entry("esbuild", "0.1.0", { hasInstallScript: true }),
  });
  assert.equal(
    checkNpmLock(text, { ref, integrity: "sha512-server-x", registry }).needsScripts,
    true,
  );
});

test("foreign sources, links and missing hashes are refused", () => {
  for (const extra of [
    {
      "node_modules/a": {
        version: "1.0.0",
        resolved: "https://evil.example/a.tgz",
        integrity: "sha512-a",
      },
    },
    {
      "node_modules/a": { version: "1.0.0", resolved: "git+https://github.com/a/a.git" },
    },
    { "node_modules/a": { link: true, resolved: "../a" } },
    { "node_modules/a": { version: "1.0.0", resolved: `${registry}/a/-/a-1.0.0.tgz` } },
    { "../outside": entry("a", "1.0.0") },
  ])
    assert.throws(
      () => checkNpmLock(lock(extra), { ref, integrity: "sha512-server-x", registry }),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      JSON.stringify(extra),
    );
});

test("bundled children are accepted only under a hashed parent", () => {
  const ok = lock({
    "node_modules/server-x/node_modules/inner": { version: "1.0.0", inBundle: true },
  });
  assert.doesNotThrow(() =>
    checkNpmLock(ok, { ref, integrity: "sha512-server-x", registry }),
  );
});

test("a top-level integrity that differs from the registry is refused", () => {
  assert.throws(
    () => checkNpmLock(lock({}), { ref, integrity: "sha512-other", registry }),
    {
      code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
    },
  );
  assert.throws(
    () =>
      checkNpmLock(lock({}), {
        ref: { ...ref, version: "2.0.0" },
        integrity: "sha512-server-x",
        registry,
      }),
    { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" },
  );
});

test("lockDiff lists added, removed and changed packages", () => {
  assert.deepEqual(
    lockDiff(
      [
        { name: "a", version: "1.0.0" },
        { name: "b", version: "1.0.0" },
      ],
      [
        { name: "a", version: "1.1.0" },
        { name: "c", version: "2.0.0" },
      ],
    ),
    {
      added: [{ name: "c", version: "2.0.0" }],
      removed: [{ name: "b", version: "1.0.0" }],
      changed: [{ name: "a", from: "1.0.0", to: "1.1.0" }],
    },
  );
});
