import test from "node:test";
import assert from "node:assert/strict";
import {
  interpreters,
  stdioGrants,
} from "../../server/features/mcp-servers/cli-grants.js";

const heads = {
  "/opt/tools/server.js": "#!/usr/bin/env -S node --no-warnings\nconsole.log(1)\n",
  "/opt/tools/run.sh": "#!/bin/sh -e\necho\n",
  "/opt/tools/bin": "\u007fELF\u0002",
};
const options = {
  pathEnv: "/fake/bin",
  exists: (file) => file === "/fake/bin/node",
  readHead: (file) => {
    if (!Object.hasOwn(heads, file))
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return heads[file];
  },
  realpath: (file) => (file === "/opt/link" ? "/opt/tools/server.js" : file),
};

test("interpreters come from the #! line; env names are resolved on PATH", () => {
  assert.deepEqual(interpreters("/opt/tools/server.js", options), [
    "/usr/bin/env",
    "/fake/bin/node",
  ]);
  assert.deepEqual(interpreters("/opt/tools/run.sh", options), ["/bin/sh"]);
  assert.deepEqual(interpreters("/opt/tools/bin", options), []);
  assert.deepEqual(interpreters("/missing", options), []);
});

test("a stdio server's command, link target, interpreter and cwd are granted; remote ones nothing", () => {
  const grants = stdioGrants(
    [
      { transport: "stdio", command: "/opt/link", cwd: "/work" },
      { transport: "stdio", command: "/opt/tools/run.sh", cwd: null },
      { transport: "stdio", command: "/opt/tools/bin", cwd: null },
      { transport: "http", url: "https://mcp.example.test/mcp" },
    ],
    options,
  );
  assert.deepEqual(grants, [
    { access: "read", path: "/opt/link" },
    { access: "read", path: "/opt/tools/server.js" },
    { access: "read", path: "/usr/bin/env" },
    { access: "read", path: "/fake/bin/node" },
    { access: "allow", path: "/work" },
    { access: "read", path: "/opt/tools/run.sh" },
    { access: "read", path: "/bin/sh" },
    { access: "read", path: "/opt/tools/bin" },
  ]);
});
