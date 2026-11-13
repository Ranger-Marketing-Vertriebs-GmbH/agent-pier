import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODING_CLI_IDS } from "../../server/features/clis/catalog.js";
import { cliDriver } from "../../server/features/clis/drivers.js";
import { writePrivate } from "../../server/lib/storage.js";
import { sessionServers, sessionShapes } from "../fixtures/cli-mcp-shapes.js";

const temporary = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-session-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const manifest = (name) => ({ name, version: "1.0.0", description: "Test plugin." });

test("every coding CLI driver adds MCP servers and reminders to a launch", () => {
  for (const id of CODING_CLI_IDS)
    for (const method of ["addMcpServer", "addReminder"])
      assert.equal(typeof cliDriver(id)[method], "function", `${id}.${method}`);
});

test("Codex takes each MCP server as one -c mcp_servers.<name> override", () => {
  const launch = { args: [], env: {} };
  for (const server of sessionServers) cliDriver("codex").addMcpServer(launch, server);
  assert.deepEqual(launch, sessionShapes.codex);
});

test("OpenCode merges each MCP server into OPENCODE_CONFIG_CONTENT", () => {
  const launch = { args: [], env: {} };
  for (const server of sessionServers) cliDriver("opencode").addMcpServer(launch, server);
  assert.deepEqual(launch.args, sessionShapes.opencode.args);
  assert.deepEqual(
    JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT),
    sessionShapes.opencode.config,
  );
  // Existing content stays, in its order, ahead of the added servers.
  const kept = { args: [], env: { OPENCODE_CONFIG_CONTENT: '{"plugin":["x"]}' } };
  cliDriver("opencode").addMcpServer(kept, sessionServers[0]);
  assert.equal(
    kept.env.OPENCODE_CONFIG_CONTENT,
    JSON.stringify({
      plugin: ["x"],
      mcp: { agentpier_one: sessionShapes.opencode.config.mcp.agentpier_one },
    }),
  );
});

test("Claude Code gets one --plugin-dir per server with its manifest and .mcp.json", (t) => {
  const root = temporary(t);
  const launch = { args: [], env: {} };
  const plugins = sessionServers.map((server, index) => {
    const plugin = path.join(root, `plugin-${index}`);
    cliDriver("claude").addMcpServer(launch, server, {
      pluginFolder: () => plugin,
      manifest: manifest(`agentpier-${index}`),
      write: writePrivate,
    });
    return plugin;
  });
  assert.deepEqual(launch, {
    args: plugins.flatMap((plugin) => ["--plugin-dir", plugin]),
    env: {},
  });
  plugins.forEach((plugin, index) => {
    const read = (file) => fs.readFileSync(path.join(plugin, file), "utf8");
    assert.equal(
      read(".claude-plugin/plugin.json"),
      JSON.stringify(manifest(`agentpier-${index}`), null, 2) + "\n",
    );
    assert.equal(
      read(".mcp.json"),
      JSON.stringify(sessionShapes.claude.mcpJson[index], null, 2) + "\n",
    );
  });
});

test("addReminder wires one start hook per CLI", (t) => {
  const root = temporary(t);
  const reminder = (folder) => ({
    name: "MEMORY",
    script: "/opt/agentpier/memory-hook.js",
    pluginUrl: "file:///opt/agentpier/memory-opencode.js",
    folder,
    invalid: () => new Error("invalid"),
  });
  const codex = { args: [], env: {} };
  cliDriver("codex").addReminder(codex, reminder());
  assert.deepEqual(codex.args, [
    "-c",
    'hooks.SessionStart=[{"hooks"=[{"type"="command","command"="\\"${AGENTPIER_HOOK_NODE:?}\\" \\"${AGENTPIER_MEMORY_HOOK:?}\\"","timeout"=5}]}]',
  ]);
  assert.equal(codex.env.AGENTPIER_MEMORY_HOOK, "/opt/agentpier/memory-hook.js");

  const opencode = { args: [], env: {} };
  cliDriver("opencode").addReminder(opencode, reminder());
  cliDriver("opencode").addReminder(opencode, reminder());
  assert.deepEqual(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT), {
    plugin: ["file:///opt/agentpier/memory-opencode.js"],
  });

  const claude = { args: [], env: {} };
  cliDriver("claude").addReminder(claude, reminder(root));
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8"));
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.deepEqual(claude.args, []);
});

test("a session server's tool timeout reaches each CLI's native field", (t) => {
  const root = temporary(t);
  const server = { name: "agentpier_slow", command: "/usr/bin/true", args: [] };
  const codex = { args: [], env: {} };
  cliDriver("codex").addMcpServer(codex, { ...server, toolTimeoutSec: 150 });
  assert.deepEqual(codex.args, [
    "-c",
    'mcp_servers.agentpier_slow={"command"="/usr/bin/true","args"=[],"tool_timeout_sec"=150}',
  ]);
  const opencode = { args: [], env: {} };
  cliDriver("opencode").addMcpServer(opencode, { ...server, toolTimeoutSec: 150 });
  assert.equal(
    JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).mcp.agentpier_slow.timeout,
    150000,
  );
  const claude = { args: [], env: {} };
  cliDriver("claude").addMcpServer(
    claude,
    { ...server, toolTimeoutSec: 150 },
    { pluginFolder: () => root, manifest: manifest("slow"), write: writePrivate },
  );
  const config = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(config.mcpServers.agentpier_slow.timeout, 150000);
});
