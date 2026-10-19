import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import {
  agentServerName,
  mcpStartSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { mcpApplyFixture as fixture } from "../helpers/mcp-apply-fixture.js";

const voice = (f) =>
  f.servers.create({
    name: "elevenlabs",
    transport: "stdio",
    command: "/abs/server",
    args: ["--serve"],
    env: {
      ELEVENLABS_MCP_BASE_PATH: "{agent.workspace}/voice",
      ELEVENLABS_API_KEY: "env-secret",
    },
  });

test("each bound agent gets its own compiled entry with its own folder, live", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const other = f.agent("Other");
  const server = voice(f);
  const workspaces = f.runtime.paths.workspaces;
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  await f.service.update(home.id, { mcpServers: [server.id], confirmStdio: true }, 1);
  await f.service.update(other.id, { mcpServers: [server.id], confirmStdio: true }, 1);
  const own = agentServerName(server, home.id);
  const theirs = agentServerName(server, other.id);
  const live = f.gateway.config.mcp.servers;
  assert.deepEqual(Object.keys(live).sort(), [own, theirs].sort());
  assert.equal(live.elevenlabs, undefined);
  assert.deepEqual(live[own], {
    command: "/abs/server",
    args: ["--serve"],
    env: {
      ELEVENLABS_MCP_BASE_PATH: path.join(workspaces, home.id, "voice"),
      ELEVENLABS_API_KEY: "env-secret",
    },
  });
  // The patch carried the resolved values; each agent only its own path.
  const patched = f.gateway.patches.at(-1).patch.mcp.servers;
  assert.equal(
    patched[theirs].env.ELEVENLABS_MCP_BASE_PATH,
    path.join(workspaces, other.id, "voice"),
  );
  assert.deepEqual(f.runtime.mcp.agentTools, {
    [home.runtimeAgentId]: [`${own}__*`],
    [other.runtimeAgentId]: [`${theirs}__*`],
  });
  assert.deepEqual(f.applied, [home.id, other.id]);
  // The overview shows each agent's resolved folder and that its entry runs.
  const [view] = f.changes.placeholderViews(f.servers.list());
  assert.deepEqual(
    view.agentFolders.map((agent) => [agent.name, agent.status, agent.values[0].value]),
    [
      ["Home", "active", path.join(workspaces, home.id, "voice")],
      ["Other", "active", path.join(workspaces, other.id, "voice")],
    ],
  );
  assert.ok(!JSON.stringify(view).includes("env-secret"));
  // Unbinding one agent removes only its entry, with its argument array listed.
  f.gateway.patches.length = 0;
  await f.service.update(other.id, { mcpServers: [] }, 2);
  assert.deepEqual(Object.keys(f.gateway.config.mcp.servers), [own]);
  assert.ok(f.gateway.patches[0].replacePaths.includes(`mcp.servers.${theirs}.args`));
});

test("an agent whose folder is a link to elsewhere gets no entry", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const other = f.agent("Other");
  const server = voice(f);
  const workspaces = f.runtime.paths.workspaces;
  fs.mkdirSync(path.join(workspaces, other.id), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(workspaces, other.id, "voice"));
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  await f.service.update(home.id, { mcpServers: [server.id], confirmStdio: true }, 1);
  await f.service.update(other.id, { mcpServers: [server.id], confirmStdio: true }, 1);
  assert.deepEqual(Object.keys(f.gateway.config.mcp.servers), [
    agentServerName(server, home.id),
  ]);
  assert.equal(f.runtime.mcp.agentTools[other.runtimeAgentId], undefined);
});

test("a Gateway start compiles the same per-agent entries and globs", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const server = voice(f);
  f.servers.setBindings("agent", home.id, [server.id]);
  const workspaces = f.runtime.paths.workspaces;
  const mcp = readMcpInputs(f.servers, { workspaces });
  const profiles = f.store.listAssistants();
  const config = compileOpenClawConfig({
    existing: {
      agents: {
        defaults: {},
        entries: { [home.runtimeAgentId]: { id: home.runtimeAgentId } },
      },
    },
    paths: { workspaces, logs: path.join(workspaces, "..", "logs") },
    port: 20000,
    token: "gateway-token",
    teams: {
      directory: "/private/plugin",
      connection: { url: "http://127.0.0.1:1235", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles,
    },
    mcp,
  });
  const name = agentServerName(server, home.id);
  assert.deepEqual(Object.keys(config.mcp.servers), [name]);
  assert.equal(
    config.mcp.servers[name].env.ELEVENLABS_MCP_BASE_PATH,
    path.join(workspaces, home.id, "voice"),
  );
  assert.ok(
    config.agents.entries[home.runtimeAgentId].tools.allow.includes(`${name}__*`),
  );
  const snapshot = mcpStartSnapshot({ profiles, mcp }, () => {});
  assert.deepEqual(snapshot.servers, [name]);
  assert.ok(!JSON.stringify(snapshot).includes("env-secret"));
});
