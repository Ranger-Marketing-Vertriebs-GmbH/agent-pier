import test from "node:test";
import assert from "node:assert/strict";
import { mcpServerConfig } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { stdioGrants } from "../../server/features/mcp-servers/cli-grants.js";

const packaged = (status) => ({
  id: "s1",
  name: "pkg",
  transport: "stdio",
  command: "/data/toolchains/node-v26.7.0-darwin-arm64/bin/node",
  args: ["/data/mcp-packages/installs/i/node_modules/x/index.js"],
  cwd: null,
  auth: "headers",
  packageStatus: status,
  managedDirs:
    status === "ready"
      ? ["/data/mcp-packages/installs/i", "/data/toolchains/node-v26.7.0-darwin-arm64"]
      : [],
});

test("OpenClaw compiles a packaged server only when its install is ready", () => {
  const secrets = { headers: {}, env: {} };
  assert.notEqual(mcpServerConfig(packaged("ready"), secrets), null);
  for (const status of ["installing", "failed", "missing"])
    assert.equal(mcpServerConfig(packaged(status), secrets), null, status);
});

test("OpenClaw skips a pending packaged server whose command is null", () => {
  const pending = { ...packaged("installing"), command: null };
  assert.equal(mcpServerConfig(pending, { headers: {}, env: {} }), null);
});

test("managed directories inside the data dir get read grants; others do not", () => {
  const grants = stdioGrants(
    [
      {
        ...packaged("ready"),
        managedDirs: [...packaged("ready").managedDirs, "/etc", "/data/assistants"],
      },
    ],
    { dataDir: "/data", realpath: (p) => p, executable: () => true, readHead: () => "" },
  );
  assert.deepEqual(
    grants.filter((g) => g.path.startsWith("/data") || g.path === "/etc"),
    [
      { access: "read", path: "/data/mcp-packages/installs/i" },
      { access: "read", path: "/data/toolchains/node-v26.7.0-darwin-arm64" },
    ],
  );
});
