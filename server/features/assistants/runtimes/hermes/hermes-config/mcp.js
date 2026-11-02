import path from "node:path";
import {
  resolveStdioServer,
  usesAgentPlaceholders,
} from "../../../../mcp-servers/agent-placeholders.js";

// The MCP servers bound to one agent (agent-desired-state.js `mcp`, the store's
// definitions and secrets in the desired state's host `mcp`, mcp-inputs.js) as
// Hermes's `mcp_servers` (website/docs/reference/mcp-config-reference.md, verified
// against Hermes v0.22.5 tools/mcp_tool_config.py). Each agent has its own home, so
// a server keeps its stored name, and Hermes names its tools `mcp__<server>__<tool>`
// (tools/mcp_tool_schema.py mcp_prefixed_tool_name).
// Secrets never stand in config.yaml: every environment value, header and URL is a
// `${NAME}` reference Hermes resolves from the home's .env when it connects
// (`_interpolate_env_vars`). The names are `AUXILIARY_AGENTPIER_MCP<n>_<kind><m>_API_KEY`,
// which Hermes strips from every command and process it starts
// (tools/environments/local_env_policy.py `_is_hermes_internal_secret`): the stdio
// server gets the value it is configured with (`_build_safe_env`), the agent's shell
// never sees it. Trust stays Hermes's default `full`, as on OpenClaw: a bound server's
// tools run without asking.

/** The .env names the MCP compile owns (home-merge.js mergeEnv prefix). */
export const mcpEnvOwned = "AUXILIARY_AGENTPIER_MCP*";
const envName = (server, kind, index) =>
  `AUXILIARY_AGENTPIER_MCP${server}_${kind}${index}_API_KEY`;
const reference = (name) => `\${${name}}`;

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const stringMap = (value) =>
  record(value) && Object.values(value).every((v) => typeof v === "string");
// A value .env cannot hold literally (home-merge.js envValue refuses it).
const envSafe = (value) => !/['\r\n]/.test(value);
// Hermes's own timeouts from the store's optional ones (mcp-timeouts.js).
const timeouts = (server) => ({
  ...(Number.isInteger(server.startupTimeoutSec)
    ? { connect_timeout: server.startupTimeoutSec }
    : {}),
  ...(Number.isInteger(server.toolTimeoutSec) ? { timeout: server.toolTimeoutSec } : {}),
});

// The agent's folders for agent placeholders (agent-placeholders.js), in its work
// folder (terminal.cwd), where Hermes starts its commands.
const foldersOf = (workspace) =>
  typeof workspace === "string" && path.isAbsolute(workspace)
    ? {
        "agent.workspace": workspace,
        "agent.attachments": path.join(workspace, "attachments"),
      }
    : null;

// One server's entry and the .env values it references, or null when it cannot be
// compiled. `n` numbers the server's .env names.
function entryOf(server, secrets, n, { workspace, pathCheck }) {
  if (server.packageStatus !== undefined && server.packageStatus !== "ready") return null;
  if (!record(secrets)) return null;
  const env = {};
  const secret = (kind, index, value) => {
    const name = envName(n, kind, index);
    env[name] = value;
    return reference(name);
  };
  if (server.transport === "stdio") {
    let { args, cwd } = server;
    let values = secrets.env ?? {};
    if (usesAgentPlaceholders(server, values)) {
      const folders = foldersOf(workspace);
      const resolved = folders && resolveStdioServer(server, values, folders);
      if (!resolved || !resolved.paths.every((p) => pathCheck(p, workspace))) return null;
      ({ args, cwd } = resolved.server);
      values = resolved.env;
    }
    if (
      typeof server.command !== "string" ||
      !path.isAbsolute(server.command) ||
      !strings(args) ||
      !stringMap(values) ||
      !Object.values(values).every(envSafe) ||
      (cwd != null && (typeof cwd !== "string" || !path.isAbsolute(cwd)))
    )
      return null;
    const names = Object.keys(values).sort();
    return {
      entry: {
        command: server.command,
        args: [...args],
        env: Object.fromEntries(
          names.map((key, i) => [key, secret("E", i + 1, values[key])]),
        ),
        ...(cwd ? { cwd } : {}),
        ...timeouts(server),
      },
      env,
    };
  }
  const headers = secrets.headers ?? {};
  if (
    !["http", "sse"].includes(server.transport) ||
    typeof server.url !== "string" ||
    !envSafe(server.url) ||
    !stringMap(headers) ||
    !Object.values(headers).every(envSafe)
  )
    return null;
  const names = Object.keys(headers).sort();
  return {
    entry: {
      url: secret("U", 1, server.url),
      ...(server.transport === "sse" ? { transport: "sse" } : {}),
      headers: Object.fromEntries(
        names.map((key, i) => [key, secret("H", i + 1, headers[key])]),
      ),
      ...timeouts(server),
    },
    env,
  };
}

/**
 * The `mcp_servers` section and .env values of `agent`'s bound servers: `{ servers,
 * env, skipped, oauth }`. `mcp`: the store's inputs (`servers`, `secrets`,
 * `pathCheck`); `workspace`: the agent's work folder. Servers keep the store's order.
 * An OAuth server whose login AgentPier holds arrives as a plain HTTP (or SSE)
 * server to AgentPier's MCP proxy (mcp-inputs.js proxiedServers) and compiles like
 * any other;
 * one whose login OpenClaw still holds is left out (`oauth`), as its tokens are
 * OpenClaw's until the owner signs in again (docs/hermes-runtime.md#mcp-servers);
 * any other server that cannot be compiled is `skipped`. Pure.
 */
export function mcpEntries(agent, mcp, { workspace } = {}) {
  const out = { servers: {}, env: {}, skipped: [], oauth: [] };
  if (!agent.mcp.eligible || !record(mcp)) return out;
  const stored = Array.isArray(mcp.servers) ? mcp.servers : [];
  const bound = new Set(agent.mcp.servers);
  const pathCheck = typeof mcp.pathCheck === "function" ? mcp.pathCheck : () => true;
  let n = 0;
  for (const server of stored) {
    if (!bound.has(server?.id)) continue;
    const name = String(server.name);
    if (server.auth === "oauth") {
      out.oauth.push(name);
      continue;
    }
    const compiled = entryOf(server, mcp.secrets?.[server.id], n + 1, {
      workspace,
      pathCheck,
    });
    if (!compiled || Object.hasOwn(out.servers, name)) {
      out.skipped.push(name);
      continue;
    }
    n++;
    out.servers[name] = compiled.entry;
    Object.assign(out.env, compiled.env);
  }
  return out;
}
