import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { writePrivate } from "../../server/lib/storage.js";
test("MCP readiness follows initialized transport, exposes tools and rejects rotation", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir });
  const input = {
    id: "session",
    account: { id: "account", tool: "opencode" },
    launch: {},
  };
  const launch = await integration.prepare(input);
  const session = {
    id: input.id,
    accountId: "account",
    tool: "opencode",
    status: "running",
    sshTools: launch.sshTools,
  };
  writePrivate(path.join(dataDir, "sessions", "session.json"), session);
  const [command, ...args] = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).mcp
    .agentpier_ssh.command;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const request = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const line = await iterator.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  };
  assert.equal(
    (await request(1, "initialize", { protocolVersion: "2025-11-25" })).result.serverInfo
      .name,
    "agentpier-ssh",
  );
  assert.equal(integration.status(session).ready, false);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  assert.equal((await request(2, "tools/list")).result.tools.length, 2);
  assert.equal(integration.status(session).ready, true);
  assert.match(
    (await request(3, "tools/call", { name: "ssh_list_hosts", arguments: {} })).result
      .content[0].text,
    /hosts/,
  );
  const old = JSON.parse(fs.readFileSync(capabilityFile(dataDir, "session")));
  await integration.prepare(input);
  assert.ok((await request(4, "tools/list")).error);
  assert.notEqual(
    JSON.parse(fs.readFileSync(capabilityFile(dataDir, "session"))).token,
    old.token,
  );
  child.stdin.end();
  await once(child, "exit");
});
