import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";

// Verified against OpenClaw 2026.9.8, see docs/assistant-mcp-qualification.md.

/** The global grant OpenClaw needs besides each agent's `<name>__*` glob. */
export const mcpGlobalTool = "bundle-mcp";
// Store transports to OpenClaw's; without `transport` OpenClaw falls back to SSE.
const httpTransports = { http: "streamable-http", sse: "sse" };
// Stored names are already OpenClaw's tool prefix (no sanitisation applies).
const serverName = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const stringMap = (value) =>
  record(value) && Object.values(value).every((v) => typeof v === "string");
const strings = (value) =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Archived agents get no MCP servers; any other agent through its own bindings. */
export function mcpEligible(profile) {
  return !!profile?.runtimeAgentId && !profile.archivedAt;
}

/**
 * The verified `mcp.servers.<name>` object, or null when the stored definition or
 * its secrets are unusable (the caller skips the server by name).
 */
export function mcpServerConfig(server, secrets) {
  if (!record(server) || !serverName.test(server.name ?? "")) return null;
  if (!record(secrets)) return null;
  const { headers = {}, env = {} } = secrets;
  if (server.transport === "stdio") {
    if (
      typeof server.command !== "string" ||
      !path.isAbsolute(server.command) ||
      !strings(server.args) ||
      !stringMap(env) ||
      (server.cwd != null &&
        (typeof server.cwd !== "string" || !path.isAbsolute(server.cwd)))
    )
      return null;
    return {
      command: server.command,
      args: [...server.args],
      env: { ...env },
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  const transport = httpTransports[server.transport];
  if (!transport || typeof server.url !== "string" || !stringMap(headers)) return null;
  return { url: server.url, transport, headers: { ...headers } };
}

/**
 * Reads what a Gateway start compiles from the MCP server store. Never throws: a
 * store that cannot be read compiles no servers; a server whose secrets cannot be
 * read gets `null` secrets and is skipped by mcpSections.
 * - `servers`: stored definitions (unredacted URL), ordered by name.
 * - `bindings`: `{ [assistantId]: serverId[] }` for `agent` targets.
 * - `secrets`: `{ [serverId]: { headers, env } | null }` for bound servers.
 */
export function readMcpInputs(store) {
  const inputs = { servers: [], bindings: {}, secrets: {}, unreadable: false };
  if (!store) return inputs;
  try {
    inputs.servers = store.definitions();
    inputs.bindings = store.bindingsByTarget("agent");
  } catch {
    return { servers: [], bindings: {}, secrets: {}, unreadable: true };
  }
  const bound = new Set(Object.values(inputs.bindings).flat());
  for (const server of inputs.servers) {
    if (!bound.has(server.id)) continue;
    try {
      inputs.secrets[server.id] = store.secrets(server.id);
    } catch {
      inputs.secrets[server.id] = null;
    }
  }
  return inputs;
}

/**
 * The Gateway sections the agents' MCP bindings need. Pure; empty (no servers, no
 * tools) when no eligible agent is bound to a usable server.
 * - `servers`: `mcp.servers`, keyed by name, in store order.
 * - `globalTools`: appended to the global `tools.allow`.
 * - `agentTools`: `{ [runtimeAgentId]: ["<name>__*", ...] }` for bound agents.
 * - `skipped`: names of bound servers left out because they cannot be compiled.
 */
export function mcpSections({
  profiles = [],
  servers = [],
  bindings = {},
  secrets = {},
}) {
  const sections = { servers: {}, globalTools: [], agentTools: {}, skipped: [] };
  const order = new Map(servers.map((server, index) => [server.id, index]));
  const compiled = new Map();
  const compile = (server) => {
    if (!compiled.has(server.id)) {
      const config = mcpServerConfig(server, secrets[server.id]);
      compiled.set(server.id, config);
      if (!config) sections.skipped.push(String(server.name));
    }
    return compiled.get(server.id);
  };
  const used = new Set();
  for (const profile of profiles) {
    if (!mcpEligible(profile)) continue;
    const ids = [...new Set(bindings[profile.id] || [])]
      .filter((id) => order.has(id))
      .sort((a, b) => order.get(a) - order.get(b));
    const tools = [];
    for (const id of ids) {
      const server = servers[order.get(id)];
      if (!compile(server)) continue;
      used.add(id);
      tools.push(`${server.name}__*`);
    }
    if (tools.length) sections.agentTools[profile.runtimeAgentId] = tools;
  }
  for (const server of servers)
    if (used.has(server.id)) sections.servers[server.name] = compiled.get(server.id);
  if (used.size) sections.globalTools = [mcpGlobalTool];
  sections.skipped.sort();
  return sections;
}

/**
 * Applies mcpSections to a configuration whose `mcp` the compiler has cleared.
 * `plugins.allow` stays as it is: `bundle-mcp` is not a plugin.
 */
export function applyMcp(config, sections) {
  if (!sections.globalTools.length) return config;
  config.mcp = { servers: sections.servers };
  config.tools.allow = [...config.tools.allow, ...sections.globalTools];
  return config;
}

// Per process, like webToolsSignature: header and env values cannot be recovered.
const signatureSecret = randomBytes(32);

/** A secret-free fingerprint of the sections, including the secrets they carry. */
export function mcpSignature(sections) {
  const { servers, globalTools, agentTools } = sections;
  return createHmac("sha256", signatureSecret)
    .update(JSON.stringify({ servers, globalTools, agentTools }))
    .digest("hex");
}

/**
 * What the supervisor keeps about a Gateway start: the per-agent globs live applies
 * grant, the compiled server names and the signature. It never holds a secret.
 */
export function mcpSnapshot(sections) {
  return {
    servers: Object.keys(sections.servers),
    globalTools: [...sections.globalTools],
    agentTools: structuredClone(sections.agentTools),
    skipped: [...sections.skipped],
    signature: mcpSignature(sections),
  };
}

/**
 * The snapshot of a Gateway start (`teams` carries `profiles` and readMcpInputs'
 * `mcp`). Servers left out are reported by name only, never with a value; they never
 * block the start.
 */
export function mcpStartSnapshot({ profiles, mcp }, warn = console.warn) {
  const sections = mcpSections({ profiles, ...mcp });
  if (mcp.unreadable) warn("Skipped MCP servers: the server store cannot be read.");
  if (sections.skipped.length)
    warn(`Skipped MCP servers that cannot be compiled: ${sections.skipped.join(", ")}`);
  return mcpSnapshot(sections);
}
