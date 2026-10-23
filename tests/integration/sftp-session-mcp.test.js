import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { startSftpServer } from "../helpers/sftp-server.js";
import { partFiles } from "../helpers/sftp-transfer-fixture.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";

const script = fileURLToPath(
  new URL("../../server/features/ssh/ssh-mcp.js", import.meta.url),
);

// The real stdio SSH MCP server of a coding session with one SFTP host granted.
async function transport(t) {
  const server = await startSftpServer();
  t.after(() => server.close());
  const f = await sshManagementFixture(t);
  const cli = await f.session("mcp");
  const host = await f.management.ui("createHost", {
    name: "Site",
    host: server.host,
    port: server.port,
    username: "deploy",
    hostKey: server.hostKey,
    type: "sftp",
    auth: "password",
    password: "pw-secret",
  });
  await f.management.grants.set(cli.record, [host.id]);
  const child = spawn(
    process.execPath,
    [script, "--data-dir", f.dataDir, "--capability", capabilityFile(f.dataDir, "mcp")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  t.after(async () => {
    child.kill("SIGKILL");
    await closed;
  });
  const responses = new Map();
  const order = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    order.push(response.id);
    responses.get(response.id)?.(response);
  });
  const write = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (id, method, params) =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      write({ jsonrpc: "2.0", id, method, params });
    });
  await request(1, "initialize", { protocolVersion: "2025-11-25" });
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  await request(2, "tools/list");
  return { server, cli, host, request, write, order };
}

const text = (response) => JSON.parse(response.result.content[0].text);

test("sftp_job and a cancellation are answered while another call waits", async (t) => {
  const mcp = await transport(t);
  fs.writeFileSync(path.join(mcp.cli.record.cwd, "big.bin"), "x".repeat(65536));
  mcp.server.stallNext("WRITE");
  const started = Date.now();
  const upload = mcp.request(10, "tools/call", {
    name: "sftp_upload",
    arguments: { accessId: mcp.host.id, localPath: "big.bin", remotePath: "/big.bin" },
  });
  // Give the upload time to reach its stalled write.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const status = await mcp.request(11, "tools/call", {
    name: "sftp_job",
    arguments: { jobId: "unknown" },
  });
  assert.equal(JSON.parse(status.result.content[0].text).code, "SFTP_JOB_NOT_FOUND");
  mcp.write({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 10, reason: "user" },
  });
  const cancelled = text(await upload);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(Date.now() - started < 9000, "cancelled before the call's wait ended");
  assert.deepEqual(mcp.order.slice(-2), [11, 10]);
  assert.deepEqual(partFiles(mcp.server.root), []);
});
