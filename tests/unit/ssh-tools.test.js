import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import { SshTools } from "../../server/features/ssh/ssh-tools.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { writePrivate } from "../../server/lib/storage.js";
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-tools-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const integration = new SshIntegration({ dataDir });
  const launch = await integration.prepare({
    id: "one",
    account: { id: "account", tool: "codex" },
    launch: {},
  });
  const session = {
    id: "one",
    accountId: "account",
    tool: "codex",
    status: "running",
    createdAt: "today",
    sshTools: launch.sshTools,
  };
  writePrivate(path.join(dataDir, "sessions", "one.json"), session);
  const capability = JSON.parse(fs.readFileSync(capabilityFile(dataDir, "one")));
  // A local synthetic executable replaces SSH, so tests never reach a remote host.
  const store = {
    list: () => [
      { id: "host", name: "Synthetic", host: "example.invalid", privateKey: "SECRET" },
      { id: "other", host: "other.invalid" },
    ],
    get: (id) => ({ id }),
    connection: () => ({ command: process.execPath, args: ["-e"], cwd: dataDir }),
  };
  const grants = new SshSessions({ dataDir, store });
  grants.set(session, ["host"]);
  return {
    tools: new SshTools({ dataDir, capability, grants, store }),
    grants,
    session,
    dataDir,
  };
}
test("SSH tools only list assigned host metadata and reauthorize every command", async (t) => {
  const { tools, grants, session } = await fixture(t);
  const hosts = await tools.call("ssh_list_hosts", {});
  assert.equal(hosts.hosts.length, 1);
  assert.equal(JSON.stringify(hosts).includes("SECRET"), false);
  assert.equal(
    (
      await tools.call("ssh_execute", {
        accessId: "host",
        command: "process.stdout.write(process.cwd())",
      })
    ).exitCode,
    0,
  );
  await assert.rejects(
    tools.call("ssh_execute", { accessId: "other", command: "process.exit(0)" }),
  );
  grants.set(session, []);
  await assert.rejects(
    tools.call("ssh_execute", { accessId: "host", command: "process.exit(0)" }),
  );
});
test("execution bounds command, output, timeout and concurrency", async (t) => {
  const { tools } = await fixture(t);
  await assert.rejects(
    tools.call("ssh_execute", { accessId: "host", command: "x".repeat(16385) }),
  );
  await assert.rejects(
    tools.call("ssh_execute", { accessId: "host", command: "true", timeoutSeconds: 121 }),
  );
  const output = await tools.call("ssh_execute", {
    accessId: "host",
    command: "process.stdout.write('x'.repeat(200000))",
  });
  assert.ok(Buffer.byteLength(output.stdout) <= 65536);
  assert.equal(output.truncated, true);
  const running = tools.call("ssh_execute", {
    accessId: "host",
    command: "setInterval(()=>{},100)",
    timeoutSeconds: 1,
  });
  await assert.rejects(
    tools.call("ssh_execute", { accessId: "host", command: "process.exit(0)" }),
    /already running/,
  );
  assert.equal((await running).timedOut, true);
});

test("revoking an assignment interrupts an active command", async (t) => {
  const { tools, grants, session } = await fixture(t);
  const running = tools.call("ssh_execute", {
    accessId: "host",
    command: "setInterval(()=>{},100)",
    timeoutSeconds: 5,
  });
  grants.set(session, []);
  await assert.rejects(running, /revoked/);
});

test("UTF-8 truncation also respects the byte budget", async (t) => {
  const { tools } = await fixture(t);
  const result = await tools.call("ssh_execute", {
    accessId: "host",
    command: "process.stdout.write('€'.repeat(100000))",
  });
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 65536);
});
