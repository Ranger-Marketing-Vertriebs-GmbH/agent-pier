import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { tomlValue } from "../../server/lib/launch-serialization.js";

const base = new URL("../../server/features/memory/", import.meta.url);
const hook = new URL("memory-hook.js", base);
async function prepare(options) {
  const module = await import(new URL("memory-discovery.js", base));
  return module.prepareMemoryDiscovery(options);
}
function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "memory-discovery-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function run(command, env, input = "{}") {
  return spawnSync("/bin/sh", ["-c", command], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout: 5000,
  });
}
function checkReminder(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length < 1000);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "SessionStart");
  assert.match(output.additionalContext, /memory_search/);
  assert.match(output.additionalContext, /targeted/);
  assert.match(output.additionalContext, /Do not automatically load or write/);
  assert.doesNotMatch(output.additionalContext, /untrusted-marker/);
}

test("Codex discovery preserves AgentBus, binding and unrelated configuration", async (t) => {
  const existing = ["agentbus", "binding"].map((command) => ({
    hooks: [{ type: "command", command }],
  }));
  const args = [
    "--config",
    `hooks.SessionStart=${tomlValue(existing)}`,
    "-c",
    "hooks.UserPromptSubmit=[]",
    "--resume",
  ];
  const env = { OTHER: "kept" };
  await prepare({ tool: "codex", folder: directory(t), args, env });
  const entries = parse(args[1]).hooks.SessionStart;
  assert.deepEqual(entries.slice(0, 2), existing);
  assert.equal(entries.length, 3);
  assert.deepEqual(args.slice(2), ["-c", "hooks.UserPromptSubmit=[]", "--resume"]);
  assert.equal(env.OTHER, "kept");
  assert.match(entries[2].hooks[0].command, /AGENTPIER_MEMORY_HOOK/);
  assert.ok(!entries[2].hooks[0].command.includes(directory(t)));
  checkReminder(run(entries[2].hooks[0].command, env, '{"prompt":"untrusted-marker"}'));
});

test("Claude discovery extends the memory plugin without replacing existing hooks", async (t) => {
  const folder = directory(t);
  fs.mkdirSync(path.join(folder, ".claude-plugin"));
  fs.mkdirSync(path.join(folder, "hooks"));
  const file = path.join(folder, "hooks/hooks.json");
  const prior = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }],
      Stop: [],
    },
  };
  fs.writeFileSync(file, JSON.stringify(prior));
  const args = ["--plugin-dir", folder];
  await prepare({ tool: "claude", folder, args, env: {} });
  const config = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(config.hooks.SessionStart[0], prior.hooks.SessionStart[0]);
  assert.deepEqual(config.hooks.Stop, []);
  assert.deepEqual(args, ["--plugin-dir", folder]);
  checkReminder(run(config.hooks.SessionStart[1].hooks[0].command));
});

test("OpenCode preserves config and adds a static reminder with its native MCP name", async (t) => {
  const original = {
    plugin: ["file:///agentbus.js"],
    provider: { local: {} },
    mcp: { other: { enabled: true } },
  };
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(original) };
  await prepare({ tool: "opencode", folder: directory(t), args: [], env });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.provider, original.provider);
  assert.deepEqual(config.mcp, original.mcp);
  assert.equal(config.plugin[0], original.plugin[0]);
  assert.equal(config.plugin.length, 2);
  const plugin = await import(config.plugin[1]);
  const hooks = await plugin.default();
  const output = { system: ["existing context"] };
  await hooks["experimental.chat.system.transform"]({}, output);
  assert.equal(output.system[0], "existing context");
  assert.match(output.system[1], /agentpier_memory_memory_search/);
  assert.ok(output.system[1].length < 1000);
  await hooks["experimental.chat.system.transform"]({}, output);
  assert.equal(output.system.length, 2);
});

test("hook rejects malformed and oversized payloads without reflecting input", () => {
  for (const input of [
    "untrusted-marker",
    JSON.stringify({ text: "untrusted-marker".repeat(10000) }),
  ]) {
    const result = spawnSync(process.execPath, [hook.pathname], {
      input,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "agentpier-memory: discovery input unavailable\n");
  }
});

test("discovery creates first native hooks and rejects incompatible config", async (t) => {
  const folder = directory(t);
  const args = [];
  const env = {};
  await prepare({ tool: "codex", folder, args, env });
  assert.equal(args[0], "-c");
  checkReminder(run(parse(args[1]).hooks.SessionStart[0].hooks[0].command, env));
  await prepare({ tool: "claude", folder, args: [], env: {} });
  const claude = JSON.parse(fs.readFileSync(path.join(folder, "hooks/hooks.json")));
  checkReminder(run(claude.hooks.SessionStart[0].hooks[0].command));
  fs.writeFileSync(path.join(folder, "hooks/hooks.json"), JSON.stringify({ hooks: [] }));
  await assert.rejects(prepare({ tool: "claude", folder, args: [], env: {} }), {
    status: 409,
    code: "MEMORY_DISCOVERY_CONFIG",
  });
  await assert.rejects(
    prepare({ tool: "codex", folder, args: ["-c", "hooks.SessionStart=false"], env: {} }),
    { status: 409, code: "MEMORY_DISCOVERY_CONFIG" },
  );
  await assert.rejects(
    prepare({
      tool: "opencode",
      folder,
      args: [],
      env: { OPENCODE_CONFIG_CONTENT: '{"plugin":"file:///existing.js"}' },
    }),
    { status: 409, code: "MEMORY_DISCOVERY_CONFIG" },
  );
});
