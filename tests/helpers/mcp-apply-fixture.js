import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { nativeTools } from "../../server/features/assistants/runtime-config.js";

export const model = { connectionId: "c", modelId: "m" };
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
export function fakeGateway(initial) {
  const gateway = { config: structuredClone(initial), hash: 1, patches: [] };
  const merge = (target, patch, at, replace) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
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

export function mcpApplyFixture(t, { now, warn, redirectUrl } = {}) {
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
  const changes = new McpChanges({
    assistants: service,
    servers,
    redirectUrl,
    now,
    warn,
  });
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
