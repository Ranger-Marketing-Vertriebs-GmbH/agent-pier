import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  canonicalPypiVersion,
  packageRef,
} from "../../server/features/mcp-packages/package-spec.js";

test("npm references need a valid name and an exact version", () => {
  assert.deepEqual(
    packageRef({ registry: "npm", name: "@scope/server-x", version: "1.2.3-beta.1" }),
    { registry: "npm", name: "@scope/server-x", version: "1.2.3-beta.1" },
  );
  for (const bad of [
    { registry: "npm", name: "Upper", version: "1.0.0" },
    { registry: "npm", name: "ok", version: "^1.0.0" },
    { registry: "npm", name: "ok", version: "latest" },
    { registry: "npm", name: "git+https://x/y", version: "1.0.0" },
    { registry: "npm", name: "file:../x", version: "1.0.0" },
    { registry: "npm", name: "../x", version: "1.0.0" },
    { registry: "npm", name: "ok", version: "1.0.0 || 2.0.0" },
    { registry: "cargo", name: "ok", version: "1.0.0" },
    { registry: "npm", name: "a".repeat(215), version: "1.0.0" },
  ])
    assert.throws(
      () => packageRef(bad),
      { code: "MCP_PACKAGE_INVALID" },
      JSON.stringify(bad),
    );
});

test("no accepted npm name contains a path or URL separator sequence", () => {
  fc.assert(
    fc.property(fc.string(), (name) => {
      try {
        const ref = packageRef({ registry: "npm", name, version: "1.0.0" });
        // `a..b` is a valid npm name; only a whole `..` segment would escape.
        return (
          !ref.name.split("/").includes("..") &&
          !ref.name.includes(":") &&
          !/\s/.test(ref.name)
        );
      } catch (error) {
        return error.code === "MCP_PACKAGE_INVALID";
      }
    }),
  );
});

test("PyPI references are normalised and need an exact PEP 440 version", () => {
  assert.deepEqual(
    packageRef({ registry: "pypi", name: "MCP_Server.Time", version: "2026.10.10" }),
    { registry: "pypi", name: "mcp-server-time", version: "2026.10.10" },
  );
  assert.equal(
    packageRef({ registry: "pypi", name: "x", version: "1.0rc1" }).version,
    "1.0rc1",
  );
  for (const version of [
    "~=1.0",
    ">=1",
    "1.*",
    "1.0 ; python_version<'3'",
    "latest",
    "1.0+local",
  ])
    assert.throws(
      () => packageRef({ registry: "pypi", name: "x", version }),
      { code: "MCP_PACKAGE_INVALID" },
      version,
    );
  for (const name of ["-x", "x-", "a b", "x@https://e", "../x", "x[cli]"])
    assert.throws(
      () => packageRef({ registry: "pypi", name, version: "1.0" }),
      { code: "MCP_PACKAGE_INVALID" },
      name,
    );
  assert.equal(canonicalPypiVersion("2026.01.10"), "2026.1.10");
  assert.equal(canonicalPypiVersion("1.0RC01"), "1.0rc1");
  assert.equal(canonicalPypiVersion("0.4.1"), "0.4.1");
});

test("no accepted PyPI name contains a path, URL or extras character", () => {
  fc.assert(
    fc.property(fc.string(), (name) => {
      try {
        const ref = packageRef({ registry: "pypi", name, version: "1.0" });
        return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref.name);
      } catch (error) {
        return error.code === "MCP_PACKAGE_INVALID";
      }
    }),
  );
});
