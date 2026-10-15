import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  canonicalPypiVersion,
  packageConstraints,
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

const top = { registry: "pypi", name: "opnsense-mcp-server", version: "0.4.1" };
const refused = (constraints, ref = top) =>
  assert.throws(
    () => packageConstraints({ constraints }, ref),
    { code: "MCP_PACKAGE_INVALID", status: 400, message: /fastmcp<4/ },
    JSON.stringify(constraints),
  );

test("PyPI constraints are a name with version limits only (D4)", () => {
  assert.deepEqual(packageConstraints({}, top), []);
  assert.deepEqual(packageConstraints({ constraints: [] }, top), []);
  assert.deepEqual(
    packageConstraints(
      {
        constraints: [
          "fastmcp<4",
          " FastMCP_Slim >= 3.0 , < 4 ",
          "httpx==0.28.*",
          "a.b~=1.2rc1",
          "c!=2.0.post1",
          "d<=1.0.dev3",
          "e>1",
        ],
      },
      top,
    ),
    [
      "fastmcp<4",
      "fastmcp-slim>=3.0,<4",
      "httpx==0.28.*",
      "a-b~=1.2rc1",
      "c!=2.0.post1",
      "d<=1.0.dev3",
      "e>1",
    ],
  );
  for (const line of [
    "",
    "   ",
    "fastmcp",
    "fastmcp<",
    "fastmcp<4,",
    "fastmcp[cli]<4",
    "x @ https://example.com/x.whl",
    "https://example.com/x.whl",
    "file:///tmp/x.whl",
    "-e git+https://github.com/a/b.git",
    "--index-url https://example.com/simple",
    "-c other.txt",
    "-r other.txt",
    "x<4 ; python_version < '3.12'",
    "x<4;python_version<'3.12'",
    "x<4 --hash=sha256:aa",
    "x<4 # comment",
    "../x<1",
    "/abs/x<1",
    "./x<1",
    "x~=1.*",
    "x~=1",
    "x<1.*",
    "x===1",
    "x=1",
    "x==1.0+local",
    "x==latest",
    "x<4\ny<2",
    "x<4\r",
    "x\t<4\u00a0",
    "opnsense-mcp-server<1",
    "OpNsense_MCP.Server>=0.1",
    `x<${"1".repeat(100)}`,
  ])
    refused([line]);
  for (const value of [1, null, ["x<1"], { name: "x" }]) refused([value]);
  refused(["a<1", "A<2"]);
  refused(["a-b<1", "a_b>0"]);
  refused(Array.from({ length: 11 }, (_, i) => `p${i}<1`));
  assert.equal(
    packageConstraints(
      { constraints: Array.from({ length: 10 }, (_, i) => `p${i}<1`) },
      top,
    ).length,
    10,
  );
  refused("fastmcp<4");
  refused({ 0: "fastmcp<4" });
  refused(null);
  const npm = { registry: "npm", name: "x", version: "1.0.0" };
  assert.deepEqual(packageConstraints({}, npm), []);
  assert.deepEqual(packageConstraints({ constraints: [] }, npm), []);
  refused(["y<1"], npm);
});

test("canonical constraints are accepted again unchanged", () => {
  const name = fc.stringMatching(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,20}[A-Za-z0-9])?$/);
  const version = fc
    .array(fc.integer({ min: 0, max: 999 }), { minLength: 2, maxLength: 4 })
    .map((parts) => parts.join("."));
  const operator = fc.constantFrom("==", "!=", "~=", "<=", ">=", "<", ">");
  const spaces = fc.constantFrom("", " ", "  ");
  fc.assert(
    fc.property(name, operator, version, spaces, (n, op, v, gap) => {
      fc.pre(n.replace(/[-_.]+/g, "-").toLowerCase() !== top.name);
      const once = packageConstraints(
        { constraints: [`${n}${gap}${op}${gap}${v}`] },
        top,
      );
      assert.deepEqual(packageConstraints({ constraints: once }, top), once);
      assert.doesNotMatch(once[0], /\s/);
    }),
  );
});
