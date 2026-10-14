import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { packageRef } from "../../server/features/mcp-packages/package-spec.js";

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
