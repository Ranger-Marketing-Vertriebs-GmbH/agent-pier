import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentServerName,
  mcpSections,
  mcpSnapshot,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { safeAgentPath } from "../../server/features/assistants/openclaw-config/agent-folders.js";

const workspaces = "/data/assistants/workspaces";
const a1 = { id: "a1", runtimeAgentId: "ap-a1", capabilities: {} };
const a2 = { id: "a2", runtimeAgentId: "ap-a2", capabilities: {} };
const voice = {
  id: "s-voice",
  name: "elevenlabs",
  transport: "stdio",
  command: "/opt/bin/uvx",
  args: ["elevenlabs-mcp"],
  cwd: "{agent.workspace}",
  agentPlaceholders: true,
};
const shared = {
  id: "s-shared",
  name: "files",
  transport: "stdio",
  command: "/opt/bin/files",
  args: [],
  cwd: null,
};
const secrets = {
  "s-voice": {
    headers: {},
    env: {
      ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}/voice",
      ELEVENLABS_API_KEY: "k",
    },
  },
  "s-shared": { headers: {}, env: {} },
};
const inputs = (extra = {}) => ({
  profiles: [a1, a2],
  servers: [shared, voice],
  bindings: { a1: ["s-voice", "s-shared"], a2: ["s-voice"] },
  secrets,
  workspaces,
  ...extra,
});

test("a server with placeholders compiles one entry per bound agent", () => {
  const sections = mcpSections(inputs());
  const one = agentServerName(voice, "a1");
  const two = agentServerName(voice, "a2");
  assert.match(one, /^elevenlabs-[0-9a-f]{8}$/);
  assert.notEqual(one, two);
  // Store order; a server's agent entries follow in name order.
  assert.deepEqual(Object.keys(sections.servers), ["files", ...[one, two].sort()]);
  assert.deepEqual(sections.servers[one], {
    command: "/opt/bin/uvx",
    args: ["elevenlabs-mcp"],
    env: {
      ELEVENLABS_MCP_BASE_PATH: "/data/assistants/workspaces/a1/attachments/voice",
      ELEVENLABS_API_KEY: "k",
    },
    cwd: "/data/assistants/workspaces/a1",
  });
  assert.equal(sections.servers[two].cwd, "/data/assistants/workspaces/a2");
  // Each agent is offered only its own entry; the shared server stays one entry.
  assert.deepEqual(sections.agentTools["ap-a1"], ["files__*", `${one}__*`]);
  assert.deepEqual(sections.agentTools["ap-a2"], [`${two}__*`]);
  assert.equal(sections.servers.elevenlabs, undefined);
  assert.deepEqual(sections.skipped, []);
  // The same inputs always compile the same names and signature.
  assert.equal(
    mcpSnapshot(mcpSections(inputs())).signature,
    mcpSnapshot(sections).signature,
  );
});

test("an entry name stays within OpenClaw's 30-character prefix", () => {
  const long = { ...voice, name: "a".repeat(30) };
  const name = agentServerName(long, "a1");
  assert.equal(name.length, 30);
  assert.match(name, /^[A-Za-z][A-Za-z0-9_-]{0,29}$/);
});

test("without a workspace root, or with an unsafe folder, the agent's entry is skipped", () => {
  const none = mcpSections(inputs({ workspaces: null }));
  assert.deepEqual(Object.keys(none.servers), ["files"]);
  assert.deepEqual(none.skipped, ["elevenlabs"]);
  assert.equal(none.agentTools["ap-a2"], undefined);
  const unsafe = mcpSections(
    inputs({
      pathCheck: (target) => !target.includes("/a2/") && !target.endsWith("/a2"),
    }),
  );
  assert.deepEqual(Object.keys(unsafe.servers), ["files", agentServerName(voice, "a1")]);
  assert.deepEqual(unsafe.skipped, ["elevenlabs"]);
});

test("a stored value that no longer parses compiles nothing half-resolved", () => {
  const broken = {
    ...secrets,
    "s-voice": { headers: {}, env: { BASE: "{agent.nope}" } },
  };
  const sections = mcpSections(inputs({ secrets: broken }));
  assert.deepEqual(Object.keys(sections.servers), ["files"]);
  assert.deepEqual(sections.skipped, ["elevenlabs"]);
});

test("an entry name a stored server already uses is never taken over", () => {
  const taken = { ...shared, id: "s-taken", name: agentServerName(voice, "a2") };
  const sections = mcpSections(
    inputs({ servers: [shared, taken, voice], bindings: { a2: ["s-voice"] } }),
  );
  assert.deepEqual(Object.keys(sections.servers), []);
  assert.deepEqual(sections.skipped, ["elevenlabs"]);
});

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

test("a folder check refuses links and files on the way, accepts missing folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-folders-"));
  dirs.push(root);
  const workspace = path.join(root, "a1");
  // A workspace that does not exist yet is created by OpenClaw; nothing to follow.
  assert.equal(safeAgentPath(path.join(workspace, "attachments"), workspace), true);
  fs.mkdirSync(path.join(workspace, "attachments"), { recursive: true });
  assert.equal(
    safeAgentPath(path.join(workspace, "attachments", "voice"), workspace),
    true,
  );
  fs.symlinkSync(os.homedir(), path.join(workspace, "escape"));
  assert.equal(safeAgentPath(path.join(workspace, "escape"), workspace), false);
  assert.equal(safeAgentPath(path.join(workspace, "escape", "x"), workspace), false);
  fs.writeFileSync(path.join(workspace, "file"), "x");
  assert.equal(safeAgentPath(path.join(workspace, "file", "x"), workspace), false);
  assert.equal(safeAgentPath(path.join(root, "a2"), workspace), false);
  const linked = path.join(root, "linked");
  fs.symlinkSync(workspace, linked);
  assert.equal(safeAgentPath(path.join(linked, "attachments"), linked), false);
});
