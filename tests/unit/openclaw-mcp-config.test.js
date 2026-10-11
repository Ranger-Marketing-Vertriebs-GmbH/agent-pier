import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";
import {
  applyMcp,
  mcpSections,
  mcpSignature,
  mcpSnapshot,
  mcpStartSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

const paths = { workspaces: "/data/workspaces", logs: "/data/logs" };
const personal = { id: "a1", runtimeAgentId: "ap-a1", capabilities: {} };
const other = { id: "a2", runtimeAgentId: "ap-a2", capabilities: {} };
const archived = { ...personal, id: "a3", runtimeAgentId: "ap-a3", archivedAt: "x" };
const lead = { id: "l1", runtimeAgentId: "ap-l1", capabilities: {} };
const member = {
  id: "m1",
  runtimeAgentId: "ap-m1",
  teamMemberId: "m1",
  lifetime: "temporary",
  capabilities: {},
};
const http = {
  id: "s-http",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp?tenant=1",
  command: null,
  args: [],
  cwd: null,
};
const sse = { ...http, id: "s-sse", name: "events", transport: "sse" };
const stdio = {
  id: "s-stdio",
  name: "local_files",
  transport: "stdio",
  url: null,
  command: "/opt/homebrew/bin/npx",
  args: ["-y", "files-server"],
  cwd: "/Users/owner/work",
};
const secrets = {
  "s-http": { headers: { Authorization: "Bearer http-secret" }, env: {} },
  "s-sse": { headers: {}, env: {} },
  "s-stdio": { headers: {}, env: { FILES_TOKEN: "stdio-secret" } },
};
const servers = [http, sse, stdio];
const inputs = (bindings) => ({ servers, bindings, secrets });

function compile(profiles, mcp, extra = {}) {
  const existing = {
    agents: {
      defaults: {},
      entries: Object.fromEntries(
        profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]),
      ),
    },
    ...extra,
  };
  return compileOpenClawConfig({
    existing,
    paths,
    port: 20000,
    token: "gateway-token",
    teams: {
      directory: "/private/plugin",
      connection: { url: "http://127.0.0.1:1235", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles,
    },
    ...(mcp === undefined ? {} : { mcp }),
  });
}
const agentAllow = (config, id) => config.agents.entries[id].tools.allow;

test("no bindings compile a byte-identical configuration", () => {
  const profiles = [personal, other, archived, member];
  const before = compile(profiles);
  for (const mcp of [
    inputs({}),
    // Bindings of an archived agent and of unknown agents count as none.
    inputs({ a3: ["s-http"], nobody: ["s-stdio"] }),
    { servers: [], bindings: {}, secrets: {}, unreadable: true },
  ])
    assert.equal(JSON.stringify(compile(profiles, mcp)), JSON.stringify(before));
  assert.equal(before.mcp, undefined);
});

test("bound HTTP and stdio servers compile the verified shapes for that agent only", () => {
  const without = compile([personal, other]);
  const config = compile([personal, other], inputs({ a1: ["s-stdio", "s-http"] }));
  assert.deepEqual(config.mcp, {
    servers: {
      docs: {
        url: "https://mcp.example.test/mcp?tenant=1",
        transport: "streamable-http",
        headers: { Authorization: "Bearer http-secret" },
      },
      local_files: {
        command: "/opt/homebrew/bin/npx",
        args: ["-y", "files-server"],
        env: { FILES_TOKEN: "stdio-secret" },
        cwd: "/Users/owner/work",
      },
    },
  });
  assert.deepEqual(config.tools.allow, [...without.tools.allow, "bundle-mcp"]);
  assert.deepEqual(agentAllow(config, "ap-a1"), [
    ...agentAllow(without, "ap-a1"),
    "docs__*",
    "local_files__*",
  ]);
  assert.deepEqual(agentAllow(config, "ap-a2"), agentAllow(without, "ap-a2"));
  // bundle-mcp is not a plugin.
  assert.deepEqual(config.plugins, without.plugins);
});

test("an SSE server writes its transport; a stdio server without cwd omits it", () => {
  const sections = mcpSections({
    profiles: [personal],
    ...inputs({ a1: ["s-sse"] }),
    servers: [sse, { ...stdio, id: "s-sse-x", name: "plain", cwd: null }],
    bindings: { a1: ["s-sse", "s-sse-x"] },
    secrets: { ...secrets, "s-sse-x": { headers: {}, env: {} } },
  });
  assert.deepEqual(sections.servers.events, {
    url: http.url,
    transport: "sse",
    headers: {},
  });
  assert.deepEqual(sections.servers.plain, {
    command: stdio.command,
    args: stdio.args,
    env: {},
  });
});

test("an archived agent's bindings are ignored", () => {
  const sections = mcpSections({
    profiles: [personal, archived],
    ...inputs({ a3: ["s-http"], a1: ["s-stdio"] }),
  });
  assert.deepEqual(Object.keys(sections.servers), ["local_files"]);
  assert.deepEqual(sections.agentTools, { "ap-a1": ["local_files__*"] });
});

test("a temporary member gets servers only through its own bindings", () => {
  const profiles = [lead, member];
  const leadOnly = compile(profiles, inputs({ l1: ["s-http"] }));
  assert.ok(!agentAllow(leadOnly, "ap-m1").includes("docs__*"));
  assert.ok(agentAllow(leadOnly, "ap-l1").includes("docs__*"));
  const own = compile(profiles, inputs({ l1: ["s-http"], m1: ["s-http"] }));
  assert.ok(agentAllow(own, "ap-m1").includes("docs__*"));
});

test("a server whose secrets cannot be read is skipped with its name only", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-compile-"));
  const store = new McpServerStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const good = store.create({
    name: "good",
    transport: "http",
    url: "https://good.example.test/mcp",
    headers: { "X-Key": "good-secret" },
  });
  const bad = store.create({
    name: "broken",
    transport: "stdio",
    command: process.execPath,
    env: { TOKEN: "broken-secret" },
  });
  store.bind(good.id, "agent", "a1");
  store.bind(bad.id, "agent", "a1");
  // A corrupt row: the value is a blob, not text.
  store.db
    .prepare("UPDATE server_secrets SET value=? WHERE server_id=?")
    .run(Buffer.from([0xff, 0x00]), bad.id);
  const mcp = readMcpInputs(store);
  const warnings = [];
  const snapshot = mcpStartSnapshot({ profiles: [personal], mcp }, (m) =>
    warnings.push(m),
  );
  assert.deepEqual(warnings, ["Skipped MCP servers that cannot be compiled: broken"]);
  assert.deepEqual(snapshot.servers, ["good"]);
  assert.deepEqual(snapshot.agentTools, { "ap-a1": ["good__*"] });
  const config = compile([personal], mcp);
  assert.deepEqual(Object.keys(config.mcp.servers), ["good"]);
  assert.equal(config.mcp.servers.good.headers["X-Key"], "good-secret");
  // A store that cannot be read at all compiles nothing and never throws.
  const failing = readMcpInputs({
    definitions() {
      throw Error("disk");
    },
  });
  assert.equal(failing.unreadable, true);
  const failed = [];
  mcpStartSnapshot({ profiles: [personal], mcp: failing }, (m) => failed.push(m));
  assert.equal(failed.length, 1);
  assert.doesNotMatch(failed[0], /disk/);
});

test("a pre-existing mcp block is replaced by the compiled one", () => {
  const stale = { servers: { old: { command: "/bin/sh", args: [] } }, extra: true };
  assert.equal(compile([personal], inputs({}), { mcp: stale }).mcp, undefined);
  const config = compile([personal], inputs({ a1: ["s-http"] }), { mcp: stale });
  assert.deepEqual(Object.keys(config.mcp), ["servers"]);
  assert.deepEqual(Object.keys(config.mcp.servers), ["docs"]);
  const target = { tools: { allow: ["x"] } };
  assert.equal(applyMcp(target, mcpSections({ profiles: [] })), target);
  assert.deepEqual(target, { tools: { allow: ["x"] } });
});

test("the snapshot and signature never hold a secret but follow rotations", () => {
  const sections = mcpSections({ profiles: [personal], ...inputs({ a1: ["s-http"] }) });
  const snapshot = mcpSnapshot(sections);
  assert.doesNotMatch(JSON.stringify(snapshot), /http-secret|stdio-secret/);
  assert.equal(snapshot.signature, mcpSignature(sections));
  const rotated = mcpSections({
    profiles: [personal],
    ...inputs({ a1: ["s-http"] }),
    secrets: { ...secrets, "s-http": { headers: { Authorization: "new" }, env: {} } },
  });
  assert.notEqual(mcpSignature(rotated), snapshot.signature);
  assert.equal(
    mcpSignature(
      mcpSections({ profiles: [personal, other], ...inputs({ a1: ["s-http"] }) }),
    ),
    snapshot.signature,
  );
});

test("a start and a live apply grant the same MCP tools and the readback holds", async (t) => {
  const bindings = { a1: ["s-http", "s-stdio"] };
  const config = compile([personal], inputs(bindings));
  const snapshot = mcpSnapshot(
    mcpSections({ profiles: [personal], ...inputs(bindings) }),
  );
  const live = agentEntry({ id: "ap-a1" }, personal, {
    teamsReady: true,
    nativeReady: true,
    guardProven: false,
    mcpTools: snapshot.agentTools["ap-a1"],
  });
  assert.deepEqual(agentAllow(config, "ap-a1"), live.tools.allow);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-live-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = store.createAssistant({
    name: "Researcher",
    model: { connectionId: "c", modelId: "m" },
  });
  const effective = {
    agents: { entries: { [assistant.runtimeAgentId]: { model: "c/m" } } },
  };
  const files = {};
  const client = {
    async call(method, params) {
      if (method === "config.get")
        return { hash: "h", config: structuredClone(effective) };
      if (method === "config.patch") {
        Object.assign(effective.agents.entries, JSON.parse(params.raw).agents.entries);
        return {};
      }
      if (method === "agents.list") return { agents: [{ id: assistant.runtimeAgentId }] };
      if (method === "agents.update") return {};
      if (method === "agents.files.get")
        return {
          file:
            params.name in files ? { content: files[params.name] } : { missing: true },
        };
      if (method === "agents.files.set") {
        files[params.name] = params.content;
        return {};
      }
      assert.fail(method);
    },
  };
  const apply = new AssistantConfig({
    client,
    store,
    workspaces: dataDir,
    teamReady: () => true,
    models: { resolve: () => ({ modelRef: "c/m", release() {} }) },
  });
  let tools = ["docs__*"];
  Object.assign(apply, {
    nativeReady: () => true,
    writeGuard: () => false,
    webToolsAvailable: () => ({}),
    mcpTools: (a) => (a.runtimeAgentId === assistant.runtimeAgentId ? tools : []),
  });
  // The readback compares with the same list; a mismatch would answer 409.
  await apply.apply(assistant.id);
  const allow = () => effective.agents.entries[assistant.runtimeAgentId].tools.allow;
  assert.equal(allow().at(-1), "docs__*");
  tools = [];
  await apply.apply(assistant.id);
  assert.ok(!allow().includes("docs__*"));
});
