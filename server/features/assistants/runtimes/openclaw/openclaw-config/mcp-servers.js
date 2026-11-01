import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import {
  agentFolders,
  resolveStdioServer,
  usesAgentPlaceholders,
} from "../../../../mcp-servers/agent-placeholders.js";
import {
  agentServerName,
  mcpEligible,
  readMcpInputs,
  withInherited,
} from "../../../../mcp-servers/mcp-inputs.js";
import { asDesired } from "./desired-agents.js";

// Verified against OpenClaw 2026.10.3, see docs/assistant-mcp-qualification.md.

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

// AgentPier's own MCP terms (mcp-inputs.js), compiled here.
export { agentServerName, mcpEligible, readMcpInputs, withInherited };

/**
 * The verified `mcp.servers.<name>` object, or null when the stored definition or
 * its secrets are unusable (the caller skips the server by name). An OAuth server
 * carries no headers: OpenClaw holds its tokens and registers `redirectUrl`, the
 * AgentPier callback, by DCR (see docs/mcp-oauth-qualification.md).
 */
export function mcpServerConfig(server, secrets, redirectUrl = null) {
  if (!record(server) || !serverName.test(server.name ?? "")) return null;
  // A packaged server runs only from a verified install (docs/mcp.md).
  if (server.packageStatus !== undefined && server.packageStatus !== "ready") return null;
  if (server.auth === "oauth") return oauthServerConfig(server, redirectUrl);
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

/** `{ url, transport, auth: "oauth", oauth: { redirectUrl, scope? } }`; never stdio. */
function oauthServerConfig(server, redirectUrl) {
  const transport = httpTransports[server.transport];
  if (!transport || typeof server.url !== "string") return null;
  if (typeof redirectUrl !== "string" || !redirectUrl) return null;
  const scope = typeof server.oauthScope === "string" ? server.oauthScope.trim() : "";
  return {
    url: server.url,
    transport,
    auth: "oauth",
    oauth: { redirectUrl, ...(scope ? { scope } : {}) },
  };
}

/**
 * The Gateway sections the agents' MCP bindings need. Pure; empty (no servers, no
 * tools) when no eligible agent is bound to a usable server.
 * - `servers`: `mcp.servers`, keyed by name, in store order.
 * - `globalTools`: appended to the global `tools.allow`.
 * - `agentTools`: `{ [runtimeAgentId]: ["<name>__*", ...] }` for bound agents.
 * - `skipped`: names of bound servers left out because they cannot be compiled.
 * - `redirectUrl`: the OAuth redirect URL compiled servers carry, else null.
 * A stdio server with agent placeholders compiles one entry per bound agent instead,
 * named by agentServerName and resolved to that agent's folders below `workspaces`
 * (OpenClaw's `mcp.servers` is global; docs/assistant-mcp-qualification.md). An agent
 * whose entry cannot be resolved, whose folder fails `pathCheck` or whose entry name
 * a stored server holds gets none; the server is named in `skipped`.
 */
export function mcpSections({
  profiles = [],
  servers = [],
  bindings = {},
  secrets = {},
  redirectUrl = null,
  workspaces = null,
  pathCheck = () => true,
}) {
  const sections = {
    servers: {},
    globalTools: [],
    agentTools: {},
    skipped: [],
    redirectUrl: null,
  };
  const order = new Map(servers.map((server, index) => [server.id, index]));
  const compiled = new Map();
  const compile = (server) => {
    if (!compiled.has(server.id)) {
      const config = mcpServerConfig(server, secrets[server.id], redirectUrl);
      compiled.set(server.id, config);
      if (!config) sections.skipped.push(String(server.name));
    }
    return compiled.get(server.id);
  };
  const taken = new Set(servers.map((server) => String(server.name).toLowerCase()));
  // `{ [serverId]: Map(entry name → config) }` of the per-agent entries.
  const perAgent = new Map();
  const compileFor = (server, profile) => {
    const folders = agentFolders(workspaces, profile.id);
    const stored = secrets[server.id];
    const resolved =
      folders && record(stored) && resolveStdioServer(server, stored.env ?? {}, folders);
    const name = agentServerName(server, profile.id);
    const config =
      resolved &&
      resolved.paths.every((target) => pathCheck(target, folders["agent.workspace"])) &&
      !taken.has(name.toLowerCase()) &&
      mcpServerConfig(resolved.server, { headers: {}, env: resolved.env }, redirectUrl);
    if (!config) {
      sections.skipped.push(String(server.name));
      return null;
    }
    if (!perAgent.has(server.id)) perAgent.set(server.id, new Map());
    perAgent.get(server.id).set(name, config);
    return name;
  };
  const used = new Set();
  for (const agent of profiles) {
    const profile = asDesired(agent, { mcp: bindings[agent.id] || [] });
    if (!profile.mcp.eligible) continue;
    const ids = [...profile.mcp.servers]
      .filter((id) => order.has(id))
      .sort((a, b) => order.get(a) - order.get(b));
    const tools = [];
    for (const id of ids) {
      const server = servers[order.get(id)];
      if (usesAgentPlaceholders(server, secrets[server.id]?.env)) {
        const name = compileFor(server, profile);
        if (name) tools.push(`${name}__*`);
        continue;
      }
      if (!compile(server)) continue;
      used.add(id);
      tools.push(`${server.name}__*`);
    }
    if (tools.length) sections.agentTools[profile.runtimeAgentId] = tools;
  }
  for (const server of servers) {
    if (used.has(server.id)) sections.servers[server.name] = compiled.get(server.id);
    const entries = perAgent.get(server.id);
    if (!entries) continue;
    for (const name of [...entries.keys()].sort())
      sections.servers[name] = entries.get(name);
  }
  if (Object.keys(sections.servers).length) sections.globalTools = [mcpGlobalTool];
  if (Object.values(sections.servers).some((server) => server.auth === "oauth"))
    sections.redirectUrl = redirectUrl;
  sections.skipped = [...new Set(sections.skipped)].sort();
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

/**
 * A secret-free fingerprint of the sections, including the secrets they carry and
 * the OAuth redirect URL, so a changed origin hot-applies like any other change.
 */
export function mcpSignature(sections) {
  const { servers, globalTools, agentTools } = sections;
  return createHmac("sha256", signatureSecret)
    .update(JSON.stringify({ servers, globalTools, agentTools }))
    .digest("hex");
}

/**
 * A secret-free fingerprint of one compiled `mcp.servers` entry, so a caller can tell
 * whether the running Gateway carries a server exactly as the store compiles it now.
 */
export function mcpServerSignature(config) {
  return createHmac("sha256", signatureSecret)
    .update(JSON.stringify(config ?? null))
    .digest("hex");
}

/**
 * What the supervisor keeps about a Gateway start: the per-agent globs live applies
 * grant, the compiled server names, the OAuth redirect URL OpenClaw registered,
 * per-server signatures and the signature. It never holds a secret.
 */
export function mcpSnapshot(sections) {
  return {
    servers: Object.keys(sections.servers),
    serverSignatures: Object.fromEntries(
      Object.entries(sections.servers).map(([name, config]) => [
        name,
        mcpServerSignature(config),
      ]),
    ),
    globalTools: [...sections.globalTools],
    agentTools: structuredClone(sections.agentTools),
    skipped: [...sections.skipped],
    redirectUrl: sections.redirectUrl ?? null,
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
