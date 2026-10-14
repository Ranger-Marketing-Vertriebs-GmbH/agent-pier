import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture } from "../helpers/cli-mcp.js";
import { reasonIdentity } from "../../server/features/mcp-servers/cli-status.js";

const record = (status) => ({
  registry: "npm",
  name: "server-x",
  version: "1.0.0",
  program: "server-x",
  programPath: "index.js",
  allowScripts: false,
  lock: "{}",
  lockDigest: "d".repeat(64),
  integrity: "sha512-x",
  installId: null,
  leadingArgs: 0,
  toolchainDir: null,
  status,
  errorCode: status === "failed" ? "MCP_PACKAGE_INSTALL_FAILED" : null,
});

test("a CLI reports a packaged server that is not ready with reason package", (t) => {
  const f = cliMcpFixture(t);
  for (const status of ["installing", "failed"]) {
    const server = f.servers.create(
      { name: `pkg-${status}`, transport: "stdio", args: [] },
      { bind: [["cli", "claude"]], pendingCommand: true, packageRecord: record(status) },
    );
    const entry = f.reconciler.desired("claude").get(server.id);
    assert.equal(entry.reason, "package", status);
    assert.equal(entry.definition.command, null, status);
  }
  assert.deepEqual(reasonIdentity("package"), {
    messageKey: "mcpServers.cliReasonPackage",
  });
});
