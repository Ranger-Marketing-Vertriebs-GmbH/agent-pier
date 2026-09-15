import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { MemoryIntegration } from "../../server/features/memory/memory-integration.js";

export function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-mcp-")),
  );
  const dataDir = path.join(root, "data"),
    cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const memory = new ProjectMemory({ dataDir });
  const integration = new MemoryIntegration({ dataDir, memory });
  const f = { root, dataDir, cwd, memory, integration };
  t.after(async () => {
    await f.integration.close();
    f.memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
export async function launch(f, id, tool, extra = {}) {
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
export function descriptor(tool, launch) {
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
export function client(t, config, options = {}) {
  const child = spawn(config.command, [...(options.nodeArgs || []), ...config.args], {
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
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.result.serverInfo.name, "agentpier-memory");
    },
    async call(name, args) {
      return request("tools/call", { name, arguments: args });
    },
  };
}
export function value(response) {
  assert.equal(response.error, undefined);
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
