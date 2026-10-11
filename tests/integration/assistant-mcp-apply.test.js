import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { nativeTools } from "../../server/features/assistants/runtime-config.js";
import {
  mcpStartSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";

const model = { connectionId: "c", modelId: "m" };
const redacted = "__OPENCLAW_REDACTED__";
const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// Every array path below `value`, as OpenClaw names them in replacePaths.
const arrayPaths = (value, at) =>
  Array.isArray(value)
    ? [at]
    : record(value)
      ? Object.entries(value).flatMap(([k, v]) => arrayPaths(v, `${at}.${k}`))
      : [];
const redact = (config) =>
  JSON.parse(
    JSON.stringify(config, (key, value) =>
      ["headers", "env"].includes(key) && record(value)
        ? Object.fromEntries(Object.keys(value).map((k) => [k, redacted]))
        : value,
    ),
  );

/**
 * A Gateway that applies merge patches as OpenClaw 2026.9.8 does: removing an array
 * (or an object holding one) or replacing it needs the path in replacePaths, and
 * config.get redacts header and environment values.
 */
function fakeGateway(initial) {
  const gateway = { config: structuredClone(initial), hash: 1, patches: [] };
  const merge = (target, patch, at, replace) => {
    for (const [key, value] of Object.entries(patch)) {
      const here = at ? `${at}.${key}` : key;
      if (value === null || Array.isArray(value)) {
        for (const p of arrayPaths(target[key], here))
          if (!replace.includes(p))
            throw Object.assign(Error(`would remove entries from ${p}`), {
              code: "INVALID_REQUEST",
              answered: true,
            });
        if (value === null) delete target[key];
        else target[key] = structuredClone(value);
      } else if (record(value)) {
        if (!record(target[key])) target[key] = {};
        merge(target[key], value, here, replace);
      } else target[key] = value;
    }
  };
  gateway.client = {
    ready: true,
    subscribe: () => () => {},
    async call(method, params) {
      if (method === "config.get")
        return { config: redact(gateway.config), hash: String(gateway.hash) };
      if (method !== "config.patch") throw Error(`unexpected ${method}`);
      const patch = JSON.parse(params.raw);
      gateway.patches.push({ patch, replacePaths: params.replacePaths });
      const next = structuredClone(gateway.config);
      merge(next, patch, "", params.replacePaths || []);
      gateway.config = next;
      gateway.hash++;
      return {};
    },
  };
  return gateway;
}

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-mcp-apply-"));
  const store = new AssistantStore({ dataDir });
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (file) => file === "/abs/server",
  });
  const webTools = ["web_fetch"];
  const gateway = fakeGateway({
    tools: { allow: [...nativeTools, ...webTools] },
    agents: { entries: {} },
  });
  const applied = [];
  const runtime = Object.assign(new EventEmitter(), {
    client: gateway.client,
    webTools: { tools: webTools },
    mcp: null,
    status: () => ({ availability: "ready" }),
    close: async () => {},
  });
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [] },
    config: { apply: async (id) => applied.push(id), reset() {} },
  });
  const changes = new McpChanges({ assistants: service, servers });
  service.mcp = changes;
  t.after(async () => {
    await service.close();
    servers.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = (name) =>
    store.createAssistant({
      name,
      instructions: "",
      model,
      capabilities: { memory: false, reminders: false },
    });
  const http = (extra = {}) =>
    servers.create({
      name: "docs",
      transport: "http",
      url: "https://mcp.example.com/v1?token=query-secret",
      headers: { Authorization: "Bearer header-secret" },
      ...extra,
    });
  return { store, servers, gateway, runtime, service, changes, applied, agent, http };
}

test("binding a server patches mcp and tools.allow live and re-applies the agent", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const other = f.agent("Other");
  const docs = f.http();
  // A native Gateway started without MCP servers.
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  const saved = await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.mcpServers, [docs.id]);
  assert.equal(f.gateway.patches.length, 1);
  assert.deepEqual(f.gateway.patches[0], {
    patch: {
      tools: { allow: [...nativeTools, "web_fetch", "bundle-mcp"] },
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com/v1?token=query-secret",
            transport: "streamable-http",
            headers: { Authorization: "Bearer header-secret" },
          },
        },
      },
    },
    replacePaths: ["tools.allow"],
  });
  assert.deepEqual(f.applied, [home.id]);
  // Later readbacks grant the globs the Gateway now carries.
  assert.deepEqual(f.runtime.mcp.agentTools, { [home.runtimeAgentId]: ["docs__*"] });
  assert.deepEqual(f.runtime.mcp.servers, ["docs"]);
  assert.ok(!JSON.stringify(f.runtime.mcp).includes("secret"));
  // A second agent on the same server re-applies only that agent.
  await f.service.update(other.id, { mcpServers: [docs.id] }, 1);
  assert.deepEqual(f.applied, [home.id, other.id]);
  // Agents the owner binds expose their servers; the list does too.
  const listed = f.service.list().assistants;
  assert.deepEqual(
    listed.map((a) => a.mcpServers),
    [[docs.id], [docs.id]],
  );
});

test("a Gateway that is not ready is not patched; the next start compiles", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const docs = f.http();
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  f.runtime.client.ready = false;
  const saved = await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.deepEqual(saved.mcpServers, [docs.id]);
  assert.deepEqual(f.gateway.patches, []);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.servers.bindings("agent", home.id), [docs.id]);
  // Likewise a Gateway started without the native team plugin compiles no MCP.
  f.runtime.client.ready = true;
  f.runtime.mcp = null;
  await f.changes.update(docs.id, { revision: 1, url: "https://mcp.example.com/v2" });
  assert.deepEqual(f.gateway.patches, []);
});

test("removing a bound server removes its tools from every agent", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const other = f.agent("Other");
  const docs = f.http();
  const local = f.servers.create({
    name: "local",
    transport: "stdio",
    command: "/abs/server",
    args: ["--serve"],
    env: { TOKEN: "env-secret" },
  });
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  await f.service.update(
    home.id,
    { mcpServers: [docs.id, local.id], confirmStdio: true },
    1,
  );
  await f.service.update(other.id, { mcpServers: [local.id], confirmStdio: true }, 1);
  f.applied.length = 0;
  f.gateway.patches.length = 0;
  await f.changes.remove(local.id);
  assert.deepEqual(f.gateway.patches, [
    {
      patch: {
        tools: { allow: [...nativeTools, "web_fetch", "bundle-mcp"] },
        mcp: {
          servers: {
            local: null,
            docs: {
              url: "https://mcp.example.com/v1?token=query-secret",
              transport: "streamable-http",
              headers: { Authorization: "Bearer header-secret" },
            },
          },
        },
      },
      replacePaths: ["tools.allow", "mcp.servers.local.args"],
    },
  ]);
  assert.deepEqual(Object.keys(f.gateway.config.mcp.servers), ["docs"]);
  assert.deepEqual(f.applied, [home.id, other.id]);
  assert.deepEqual(f.runtime.mcp.agentTools, { [home.runtimeAgentId]: ["docs__*"] });
  // The last server: bundle-mcp leaves the global list as well.
  await f.changes.remove(docs.id);
  assert.deepEqual(f.gateway.config.tools.allow, [...nativeTools, "web_fetch"]);
  assert.deepEqual(f.gateway.config.mcp.servers, {});
  assert.deepEqual(f.runtime.mcp.agentTools, {});
  assert.deepEqual(f.service.list().assistants[0].mcpServers, []);
});

test("renaming re-applies bound agents; a new secret patches only the global block", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  const docs = f.http();
  f.servers.setBindings("agent", home.id, [docs.id]);
  f.runtime.mcp = mcpStartSnapshot(
    { profiles: f.store.listAssistants(), mcp: readMcpInputs(f.servers) },
    () => {},
  );
  f.gateway.config.mcp = { servers: { docs: { url: "x", transport: "sse" } } };
  await f.changes.update(docs.id, { revision: 1, headers: { Authorization: "v2" } });
  assert.equal(f.gateway.patches.length, 1);
  assert.equal(
    f.gateway.config.mcp.servers.docs.headers.Authorization,
    "v2",
    "the new value reaches the Gateway",
  );
  assert.deepEqual(f.applied, []);
  await f.changes.update(docs.id, { revision: 2, name: "manual" });
  assert.deepEqual(Object.keys(f.gateway.config.mcp.servers), ["manual"]);
  assert.deepEqual(f.applied, [home.id]);
  assert.deepEqual(f.runtime.mcp.agentTools, { [home.runtimeAgentId]: ["manual__*"] });
  // An unchanged store patches nothing.
  await f.changes.apply();
  assert.equal(f.gateway.patches.length, 2);
});

test("temporary members and archived agents cannot be bound by the owner", async (t) => {
  const f = fixture(t);
  const lead = f.agent("Lead");
  const docs = f.http();
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  const member = f.store.reserveMember({
    id: "member-1",
    parent: lead.id,
    assignment: { name: "Helper", role: "r", assignment: "a" },
    snapshot: { model, instructions: "" },
    teamId: "team-1",
    lifetime: "temporary",
  });
  await assert.rejects(f.service.update(member.id, { mcpServers: [docs.id] }, 1), {
    status: 400,
  });
  assert.deepEqual(f.servers.bindings("agent", member.id), []);
  assert.equal(f.store.getAssistant(member.id).revision, 1);
  // Temporary members do not expose owner bindings.
  assert.equal(
    f.service.list().assistants.find((a) => a.id === member.id).mcpServers,
    undefined,
  );
  const archived = f.agent("Old");
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...archived, archivedAt: "2026-10-01" }), archived.id);
  await assert.rejects(f.service.update(archived.id, { mcpServers: [docs.id] }, 1), {
    status: 400,
  });
  // A permanent member is the owner's agent.
  const permanent = f.store.reserveMember({
    id: "member-2",
    parent: lead.id,
    assignment: { name: "Keeper", role: "r", assignment: "a" },
    snapshot: { model, instructions: "" },
    teamId: "team-1",
    lifetime: "permanent",
  });
  const saved = await f.service.update(permanent.id, { mcpServers: [docs.id] }, 1);
  assert.deepEqual(saved.mcpServers, [docs.id]);
  assert.deepEqual(f.gateway.patches.length, 1);
});

test("stdio servers need the owner's confirmation; nothing is persisted without it", async (t) => {
  const f = fixture(t);
  const home = f.agent("Home");
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  const input = {
    name: "local",
    transport: "stdio",
    command: "/abs/server",
    args: [],
    env: { TOKEN: "env-secret" },
  };
  await assert.rejects(f.changes.create(input), {
    status: 409,
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  assert.deepEqual(f.servers.list(), []);
  const local = await f.changes.create(input, { confirmStdio: true });
  await assert.rejects(f.service.update(home.id, { mcpServers: [local.id] }, 1), {
    status: 409,
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  assert.deepEqual(f.servers.bindings("agent", home.id), []);
  assert.equal(f.store.getAssistant(home.id).revision, 1);
  assert.deepEqual(f.gateway.patches, []);
  await f.service.update(home.id, { mcpServers: [local.id], confirmStdio: true }, 1);
  assert.deepEqual(f.servers.bindings("agent", home.id), [local.id]);
  // Keeping an already bound stdio server needs no new confirmation.
  const docs = f.http();
  await f.service.update(home.id, { mcpServers: [local.id, docs.id] }, 2);
  assert.deepEqual(f.servers.bindings("agent", home.id), [docs.id, local.id]);
  assert.deepEqual(f.gateway.config.mcp.servers.local, {
    command: "/abs/server",
    args: [],
    env: { TOKEN: "env-secret" },
  });
});
