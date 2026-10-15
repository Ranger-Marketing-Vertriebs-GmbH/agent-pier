import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkNpmLock, lockDiff } from "../../server/features/mcp-packages/lock-check.js";

const sri = (name) => `sha512-${createHash("sha512").update(name).digest("base64")}`;
const registry = "https://registry.npmjs.org";
const ref = { registry: "npm", name: "server-x", version: "1.1.0" };
const entry = (name, version, extra = {}) => ({
  version,
  resolved: `${registry}/${name}/-/${name}-${version}.tgz`,
  integrity: sri(name),
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
  const result = checkNpmLock(text, { ref, integrity: sri("server-x"), registry });
  assert.equal(result.needsScripts, false);
  assert.deepEqual(result.dependencies, [
    { name: "server-x", version: "1.1.0", path: "server-x" },
    { name: "zod", version: "3.0.0", path: "zod" },
  ]);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("install scripts anywhere in the graph are reported", () => {
  const text = lock({
    "node_modules/esbuild": entry("esbuild", "0.1.0", { hasInstallScript: true }),
  });
  assert.equal(
    checkNpmLock(text, { ref, integrity: sri("server-x"), registry }).needsScripts,
    true,
  );
});

test("foreign sources, links and missing hashes are refused", () => {
  for (const extra of [
    {
      "node_modules/a": {
        version: "1.0.0",
        resolved: "https://evil.example/a.tgz",
        integrity: sri("a"),
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
      () => checkNpmLock(lock(extra), { ref, integrity: sri("server-x"), registry }),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      JSON.stringify(extra),
    );
});

test("bundled children are accepted only under a hashed parent", () => {
  const ok = lock({
    "node_modules/server-x/node_modules/inner": { version: "1.0.0", inBundle: true },
  });
  assert.doesNotThrow(() =>
    checkNpmLock(ok, { ref, integrity: sri("server-x"), registry }),
  );
});

const check = (extra) =>
  checkNpmLock(lock(extra), { ref, integrity: sri("server-x"), registry });

test("bundled entries outside a hashed parent or with a source are refused", () => {
  for (const extra of [
    { "node_modules/b": { version: "1.0.0", inBundle: true } },
    {
      "node_modules/server-x/node_modules/b": {
        version: "1.0.0",
        inBundle: true,
        resolved: "https://evil.example/b.tgz",
      },
    },
    { "node_modules/other/node_modules/b": { version: "1.0.0", inBundle: true } },
    { "node_modules/a": null },
  ])
    assert.throws(() => check(extra), { code: "MCP_PACKAGE_FOREIGN_SOURCE" });
});

test("nested bundles under a hashed root are accepted", () => {
  assert.doesNotThrow(() =>
    check({
      "node_modules/server-x/node_modules/b": { version: "1.0.0", inBundle: true },
      "node_modules/server-x/node_modules/b/node_modules/c": {
        version: "1.0.0",
        inBundle: true,
      },
    }),
  );
});

test("a lock without a packages object is malformed", () => {
  const options = { ref, integrity: sri("server-x"), registry };
  assert.throws(
    () => checkNpmLock(JSON.stringify({ lockfileVersion: 3, packages: null }), options),
    { code: "MCP_PACKAGE_INSTALL_FAILED" },
  );
});

test("non-string versions and odd key segments are refused", () => {
  assert.throws(
    () => check({ "node_modules/a": { ...entry("a", "1.0.0"), version: 1 } }),
    {
      code: "MCP_PACKAGE_FOREIGN_SOURCE",
    },
  );
  for (const key of [
    "node_modules//a",
    "node_modules/./a",
    "node_modules/a/../b",
    "node_modules\\a",
  ])
    assert.throws(() => check({ [key]: entry("a", "1.0.0") }), {
      code: "MCP_PACKAGE_FOREIGN_SOURCE",
    });
});

test("a top-level integrity that differs from the registry is refused", () => {
  assert.throws(
    () => checkNpmLock(lock({}), { ref, integrity: sri("other"), registry }),
    {
      code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
    },
  );
  assert.throws(
    () =>
      checkNpmLock(lock({}), {
        ref: { ...ref, version: "2.0.0" },
        integrity: sri("server-x"),
        registry,
      }),
    { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" },
  );
});

test("lockDiff lists added, removed and changed packages", () => {
  assert.deepEqual(
    lockDiff(
      [
        { name: "a", version: "1.0.0", path: "a" },
        { name: "b", version: "1.0.0", path: "b" },
      ],
      [
        { name: "a", version: "1.1.0", path: "a" },
        { name: "c", version: "2.0.0", path: "c" },
      ],
    ),
    {
      added: [{ name: "c", version: "2.0.0", path: "c" }],
      removed: [{ name: "b", version: "1.0.0", path: "b" }],
      changed: [{ name: "a", path: "a", from: "1.0.0", to: "1.1.0" }],
    },
  );
});

test("nested copies of one package stay separate entries, keyed by their path", () => {
  const text = lock({
    "node_modules/zod": entry("zod", "3.0.0"),
    "node_modules/server-x/node_modules/zod": entry("zod", "2.0.0"),
    "node_modules/@a/b": entry("@a/b", "1.0.0"),
    "node_modules/@a/b/node_modules/zod": entry("zod", "2.0.0"),
  });
  const { dependencies } = checkNpmLock(text, {
    ref,
    integrity: sri("server-x"),
    registry,
  });
  assert.deepEqual(
    dependencies.filter((d) => d.name === "zod"),
    [
      { name: "zod", version: "2.0.0", path: "@a/b > zod" },
      { name: "zod", version: "2.0.0", path: "server-x > zod" },
      { name: "zod", version: "3.0.0", path: "zod" },
    ],
  );
});

test("lockDiff compares packages by name and path, never merging nested copies", () => {
  const top = (version) => ({ name: "zod", version, path: "zod" });
  const nested = (version) => ({
    name: "zod",
    version,
    path: "server-x > zod",
  });
  assert.deepEqual(
    lockDiff([top("3.0.0"), nested("2.0.0")], [top("3.1.0"), nested("2.0.0")]),
    {
      added: [],
      removed: [],
      changed: [{ name: "zod", path: "zod", from: "3.0.0", to: "3.1.0" }],
    },
  );
  assert.deepEqual(lockDiff([top("3.0.0")], [top("3.0.0"), nested("2.0.0")]), {
    added: [nested("2.0.0")],
    removed: [],
    changed: [],
  });
});

test("an integrity that is not one full sha512 value is foreign", () => {
  for (const bad of [
    "sha512-short",
    `${sri("zod")} sha1-abc`,
    `${sri("zod")}\n`,
    `sha512-${"A".repeat(87)}=`,
  ])
    assert.throws(
      () =>
        checkNpmLock(
          lock({ "node_modules/zod": entry("zod", "3.0.0", { integrity: bad }) }),
          { ref, integrity: sri("server-x"), registry },
        ),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      bad,
    );
});
