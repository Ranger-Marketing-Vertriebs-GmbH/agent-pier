import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { SshIntegration } from "../../server/features/ssh/ssh-integration.js";
import { writePrivate, privateDirectory } from "../../server/lib/storage.js";
const hostId = "11111111-1111-1111-1111-111111111111";
const keyId = "22222222-2222-2222-2222-222222222222";
for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(
    `same-generation MCP recovers after ${signal} during execution`,
    { timeout: 15000 },
    async (t) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-restart-"));
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      const bin = privateDirectory(path.join(dataDir, "bin"));
      fs.writeFileSync(
        path.join(bin, "ssh"),
        `#!${process.execPath}\nconst command=process.argv.at(-1);\nif(command==='wait'){require('fs').writeFileSync(${JSON.stringify(path.join(dataDir, "started"))},String(process.pid));setTimeout(()=>{},1500);}else process.stdout.write('synthetic-ok');\n`,
        { mode: 0o700 },
      );
      writePrivate(path.join(dataDir, "ssh", "keys.json"), [
        {
          id: keyId,
          name: "Synthetic",
          publicKey: "ssh-ed25519 synthetic",
          fingerprint: "synthetic",
        },
      ]);
      writePrivate(path.join(dataDir, "ssh", "accesses.json"), [
        {
          id: hostId,
          keyId,
          name: "Synthetic",
          host: "example.invalid",
          port: 22,
          username: "test",
        },
      ]);
      privateDirectory(path.join(dataDir, "ssh", "keys", hostId));
      const integration = new SshIntegration({ dataDir });
      const launch = await integration.prepare({
        id: "session",
        account: { id: "account", tool: "opencode" },
        launch: {},
      });
      const session = {
        id: "session",
        accountId: "account",
        tool: "opencode",
        status: "running",
        createdAt: "today",
        sshTools: launch.sshTools,
      };
      writePrivate(path.join(dataDir, "sessions", "session.json"), session);
      writePrivate(path.join(dataDir, "ssh", "grants", "session.json"), {
        identity: [session.id, session.accountId, session.tool, session.createdAt],
        accessIds: [hostId],
      });
      const [command, ...args] = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).mcp
        .agentpier_ssh.command;
      async function connect() {
        const child = spawn(command, args, {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          stdio: ["pipe", "pipe", "pipe"],
        });
        t.after(() => child.kill("SIGKILL"));
        const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
        const send = (id, method, params) =>
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        const next = async () => JSON.parse((await lines.next()).value);
        send(1, "initialize");
        await next();
        send(undefined, "notifications/initialized");
        send(2, "tools/list");
        await next();
        return { child, send, next };
      }
      const first = await connect();
      first.send(3, "tools/call", {
        name: "ssh_execute",
        arguments: { accessId: hostId, command: "wait" },
      });
      while (!fs.existsSync(path.join(dataDir, "started")))
        await new Promise((resolve) => setTimeout(resolve, 20));
      const exited = once(first.child, "exit");
      first.child.kill(signal);
      await exited;
      const second = await connect();
      second.send(3, "tools/call", {
        name: "ssh_execute",
        arguments: { accessId: hostId, command: "ok" },
      });
      const result = (await second.next()).result;
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).stdout, "synthetic-ok");
      const stopped = once(second.child, "exit");
      second.child.stdin.end();
      await stopped;
    },
  );
}
