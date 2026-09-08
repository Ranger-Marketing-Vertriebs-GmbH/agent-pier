import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { MemoryIntegration } from "../../server/features/memory/memory-integration.js";

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-mcp-")),
  );
  const dataDir = path.join(root, "data"),
    cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const memory = new ProjectMemory({ dataDir });
  const integration = new MemoryIntegration({ dataDir, memory });
  t.after(() => {
    integration.close();
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, cwd, memory, integration };
}
async function launch(f, id, tool, extra = {}) {
  return f.integration.prepare({
    id,
    account: { id: `profile-${tool}`, tool },
    cwd: f.cwd,
    launch: {
      command: "inert-native-command",
      args: ["--existing"],
      env: {
        HOME: f.root,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugin: ["file:///existing-plugin"],
          mcp: { existing: { type: "local", command: ["/bin/false"] } },
          model: "native/model",
        }),
      },
    },
    ...extra,
  });
}
function descriptor(tool, launch) {
  if (tool === "codex")
    return parseToml(
      launch.args.find((a) => a.startsWith("mcp_servers.agentpier_memory=")),
    ).mcp_servers.agentpier_memory;
  if (tool === "claude") {
    const plugin = launch.args[launch.args.lastIndexOf("--plugin-dir") + 1];
    return JSON.parse(fs.readFileSync(path.join(plugin, ".mcp.json"), "utf8")).mcpServers
      .agentpier_memory;
  }
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).mcp.agentpier_memory;
  return { command: config.command[0], args: config.command.slice(1) };
}
function client(t, config) {
  const child = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: os.tmpdir() },
  });
  let buffer = "",
    next = 0;
  const waiting = new Map();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const pending = waiting.get(message.id);
      if (pending) {
        waiting.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  });
  child.stderr.resume();
  t.after(async () => {
    child.stdin.end();
    child.kill();
    await exited;
  });
  function request(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("MCP fixture response timed out")),
        10000,
      );
      waiting.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  return {
    child,
    request,
    async initialize() {
      const result = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      });
      assert.equal(result.result.serverInfo.name, "agentpier-memory");
    },
    async call(name, args) {
      return request("tools/call", { name, arguments: args });
    },
  };
}
function value(response) {
  assert.equal(response.error, undefined);
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

test("all three native MCP adapters share scope, preserve configuration and survive web store restart", async (t) => {
  const f = fixture(t),
    clients = [];
  let projectId;
  for (const tool of ["codex", "claude", "opencode"]) {
    const prepared = await launch(f, tool, tool);
    assert.equal(prepared.args[0], "--existing");
    projectId ??= prepared.memory.projectId;
    assert.equal(prepared.memory.projectId, projectId);
    if (tool === "opencode") {
      const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT);
      assert.deepEqual(config.plugin, ["file:///existing-plugin"]);
      assert.equal(config.model, "native/model");
      assert.ok(config.mcp.existing);
    }
    const connection = client(t, descriptor(tool, prepared));
    await connection.initialize();
    clients.push(connection);
  }
  const saved = value(
    await clients[0].call("memory_write", {
      title: "Shared contract",
      content: "Untrusted fixture knowledge",
    }),
  );
  assert.equal(saved.provenance.tool, "codex");
  assert.equal(saved.provenance.sessionId, "codex");
  assert.equal(
    value(await clients[1].call("memory_search", { query: "Shared" })).items[0].id,
    saved.id,
  );
  const updated = value(
    await clients[2].call("memory_write", {
      id: saved.id,
      title: "Shared contract",
      content: "A newer contract",
      expectedRevision: 1,
    }),
  );
  assert.equal(updated.revision, 2);
  f.memory.close();
  assert.equal(
    value(await clients[1].call("memory_read", { id: saved.id })).content,
    "A newer contract",
  );
  const reopened = new ProjectMemory({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  assert.equal(reopened.read(projectId, saved.id).revision, 2);
});
test("concurrent MCP writers reject a stale revision and callers cannot choose scope or provenance", async (t) => {
  const f = fixture(t);
  const a = client(t, descriptor("codex", await launch(f, "one", "codex"))),
    b = client(t, descriptor("claude", await launch(f, "two", "claude")));
  await Promise.all([a.initialize(), b.initialize()]);
  const saved = value(
    await a.call("memory_write", { title: "Original", content: "Original" }),
  );
  const results = await Promise.all([
    a.call("memory_write", {
      id: saved.id,
      title: "A",
      content: "A",
      expectedRevision: 1,
    }),
    b.call("memory_write", {
      id: saved.id,
      title: "B",
      content: "B",
      expectedRevision: 1,
    }),
  ]);
  assert.equal(results.filter((r) => r.result?.isError).length, 1);
  assert.equal(value(await a.call("memory_read", { id: saved.id })).revision, 2);
  for (const args of [
    { title: "Spoof", content: "Spoof", projectId: "foreign" },
    { title: "Spoof", content: "Spoof", provenance: { kind: "user" } },
  ])
    assert.equal((await a.call("memory_write", args)).result.isError, true);
  const other = path.join(f.root, "other");
  fs.mkdirSync(other);
  const foreign = client(
    t,
    descriptor("opencode", await launch(f, "foreign", "opencode", { cwd: other })),
  );
  await foreign.initialize();
  assert.equal(
    (await foreign.call("memory_read", { id: saved.id })).result.isError,
    true,
  );
});
test("revoked or replaced capability files fail closed without deleting durable entries", async (t) => {
  const f = fixture(t);
  const prepared = await launch(f, "revoked", "codex");
  const c = client(t, descriptor("codex", prepared));
  await c.initialize();
  const saved = value(
    await c.call("memory_write", { title: "Retained", content: "Retained" }),
  );
  await f.integration.discard("revoked");
  assert.equal((await c.call("memory_read", { id: saved.id })).result.isError, true);
  assert.equal(f.memory.read(prepared.memory.projectId, saved.id).title, "Retained");
  const next = await launch(f, "corrupt", "codex");
  const folder = path.join(f.dataDir, "memory", "sessions", "corrupt");
  const file = path.join(folder, "capability.json");
  const secret = JSON.parse(fs.readFileSync(file));
  secret.token = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(secret));
  const wrong = client(t, descriptor("codex", next));
  assert.ok((await wrong.request("initialize")).error);
});
test("shell and login launches receive no memory files or arguments", async (t) => {
  const f = fixture(t);
  for (const input of [
    { id: "shell", account: { id: "local-shell", tool: "shell" } },
    { id: "login", account: { id: "local-codex", tool: "codex" }, purpose: "login" },
  ]) {
    const original = { args: [], env: {} };
    const result = await f.integration.prepare({
      ...input,
      cwd: f.cwd,
      launch: original,
    });
    assert.equal(result, original);
  }
  assert.equal(f.memory.projects().projects.length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, "memory", "sessions")), false);
});

test("stdio rejects oversized lines and unknown tools without performing a write", async (t) => {
  const f = fixture(t);
  const prepared = await launch(f, "bounded", "codex");
  const config = descriptor("codex", prepared);
  const c = client(t, config);
  await c.initialize();
  assert.equal(
    (await c.call("memory_execute", { command: "echo unsafe" })).result.isError,
    true,
  );
  const stopped = new Promise((resolve) => c.child.once("exit", resolve));
  c.child.stdin.write("x".repeat(65537));
  assert.equal(await stopped, 1);
  assert.equal(f.memory.list(prepared.memory.projectId).total, 0);
});

test("native adapter rejects malformed reserved config without issuing a capability", async (t) => {
  const f = fixture(t);
  for (const config of ["{broken", "[]", '{"mcp":[]}', '{"mcp":{"agentpier_memory":{}}}'])
    await assert.rejects(
      launch(f, "bad", "opencode", {
        launch: { args: [], env: { OPENCODE_CONFIG_CONTENT: config } },
      }),
      { status: 409 },
    );
  assert.equal(fs.existsSync(path.join(f.dataDir, "memory", "sessions", "bad")), false);
});

test("MCP search returns bounded excerpts and explicit reads preserve complete content", async (t) => {
  const f = fixture(t);
  const prepared = await launch(f, "search-budget", "codex");
  let saved;
  for (let i = 0; i < 20; i++)
    saved = f.memory.write(prepared.memory.projectId, {
      title: `Large entry ${i}`,
      content: "x".repeat(32000),
    });
  const c = client(t, descriptor("codex", prepared));
  await c.initialize();
  const response = await c.call("memory_search", {});
  const result = value(response);
  assert.equal(result.items.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 32768);
  assert.equal(result.items[0].content, undefined);
  assert.equal(result.items[0].excerpt.length, 256);
  assert.equal(
    value(await c.call("memory_read", { id: saved.id })).content.length,
    32000,
  );
});
