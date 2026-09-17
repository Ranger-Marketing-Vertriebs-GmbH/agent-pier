import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { SshManagement } from "../../server/features/ssh/ssh-management.js";
import { capabilityFile } from "../../server/features/ssh/ssh-capability.js";
import { writePrivate } from "../../server/lib/storage.js";

const script = fileURLToPath(
  new URL("../../server/features/ssh/ssh-mcp.js", import.meta.url),
);
function transport(t, dataDir, credential) {
  const child = spawn(
    process.execPath,
    [script, "--data-dir", dataDir, "--capability", credential],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close").catch(() => {});
  const pending = new Map();
  let sequence = 0,
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const rejectPending = () => {
    for (const item of pending.values())
      item.reject(new Error("SSH MCP closed before response"));
    pending.clear();
  };
  child.on("error", rejectPending);
  child.on("close", rejectPending);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      rejectPending();
      return;
    }
    pending.get(response.id)?.resolve(response);
    pending.delete(response.id);
  });
  let cleanup;
  const close = () =>
    (cleanup ||= (async () => {
      child.kill("SIGKILL");
      await closed;
      lines.close();
    })());
  t.after(close);
  const request = (method, params) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("SSH MCP request timed out"));
      }, 5000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const initialize = async () => {
    const response = await request("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(response.result?.serverInfo.name, "agentpier-ssh");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    return (await request("tools/list")).result.tools.map((tool) => tool.name);
  };
  const call = (name, args = {}) => request("tools/call", { name, arguments: args });
  return { initialize, request, call, close, stderr: () => stderr };
}
function value(response) {
  assert.equal(response.error, undefined);
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE KEY/);
  return JSON.parse(response.result.content[0].text);
}

test(
  "real stdio MCP provisions public project metadata through the management service",
  { timeout: 15000 },
  async (t) => {
    const f = await sshManagementFixture(t),
      session = await f.session("stdio");
    const mcp = transport(t, f.dataDir, capabilityFile(f.dataDir, session.record.id));
    try {
      const names = await mcp.initialize();
      for (const name of [
        "ssh_generate_key",
        "ssh_import_key",
        "ssh_get_public_key",
        "ssh_list_keys",
      ])
        assert.ok(names.includes(name));
      assert.equal(
        names.some((name) => /download|export/.test(name)),
        false,
      );
      const input = { name: "MCP deployment", requestId: "stdio-generate" };
      const key = value(await mcp.call("ssh_generate_key", input));
      assert.match(key.publicKey, /^ssh-ed25519 /);
      assert.equal(key.projectId, session.project.projectId);
      assert.equal(value(await mcp.call("ssh_generate_key", input)).id, key.id);
      const source = path.join(f.home, "stdio-source");
      const bytes = fs.readFileSync(
        path.join(f.dataDir, "ssh", "identities", key.id, "identity"),
      );
      fs.writeFileSync(source, bytes, { mode: 0o600 });
      const imported = value(
        await mcp.call("ssh_import_key", {
          name: "Imported source",
          sourcePath: source,
          requestId: "stdio-import",
        }),
      );
      assert.equal(imported.id, key.id);
      assert.equal(imported.reused, true);
      assert.deepEqual(fs.readFileSync(source), bytes);
      assert.equal(
        value(await mcp.call("ssh_get_public_key", { keyId: key.id })).publicKey,
        key.publicKey,
      );
      assert.equal(value(await mcp.call("ssh_list_keys")).total, 1);
      const denied = await mcp.call("ssh_download_private_key", { keyId: key.id });
      assert.equal(denied.result.isError, true);
      assert.doesNotMatch(JSON.stringify(denied), /PRIVATE KEY|BEGIN OPENSSH/);
      assert.doesNotMatch(mcp.stderr(), /PRIVATE KEY|BEGIN OPENSSH/);
    } finally {
      await mcp.close();
    }
  },
);

test(
  "catalog migration revokes an already initialized stdio MCP capability on its next call",
  { timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-live-cutover-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const keyId = randomUUID(),
      hostId = randomUUID();
    writePrivate(path.join(root, "ssh", "keys.json"), [
      {
        id: keyId,
        name: "Legacy key",
        publicKey: "ssh-ed25519 synthetic",
        fingerprint: "synthetic",
      },
    ]);
    writePrivate(path.join(root, "ssh", "accesses.json"), [
      {
        id: hostId,
        keyId,
        name: "Legacy host",
        host: "host.invalid",
        port: 22,
        username: "deploy",
        hostKey: "ssh-ed25519 synthetic",
      },
    ]);
    const capability = {
      sessionId: "legacy",
      accountId: "account",
      tool: "codex",
      generation: randomUUID(),
      token: randomBytes(32).toString("hex"),
    };
    const session = {
      id: "legacy",
      accountId: "account",
      tool: "codex",
      createdAt: "fixture",
      status: "running",
      sshTools: { enabled: true, generation: capability.generation },
    };
    const credential = capabilityFile(root, session.id);
    writePrivate(credential, capability);
    writePrivate(path.join(root, "sessions", "legacy.json"), session);
    writePrivate(path.join(root, "ssh", "grants", "legacy.json"), {
      identity: [session.id, session.accountId, session.tool, session.createdAt],
      accessIds: [hostId],
    });
    const mcp = transport(t, root, credential);
    let management;
    try {
      await mcp.initialize();
      const before = value(await mcp.call("ssh_list_hosts"));
      assert.equal(before.hosts[0].accessId, hostId);
      management = new SshManagement({ dataDir: root, home: root });
      await management.ready;
      assert.equal(fs.existsSync(credential), false);
      const after = await mcp.call("ssh_list_hosts");
      assert.ok(after.error);
      assert.match(after.error.message, /revoked|unavailable/i);
      assert.equal(after.result, undefined);
      assert.equal(management.store.get(hostId).projectId, null);
      assert.deepEqual(management.grants.assigned(session), [hostId]);
      assert.equal(fs.existsSync(path.join(root, "ssh", "accesses.json")), false);
    } finally {
      await mcp.close();
      await management?.close();
    }
  },
);
