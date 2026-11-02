import { createHash } from "node:crypto";
import { safeAgentPath } from "../assistants/agent-folders.js";

// What an agent's MCP bindings are in AgentPier's own terms, runtime-neutral: which
// agents get servers, the per-agent name of a server with agent placeholders (shown
// to the owner, docs/mcp.md#agent-placeholders) and the store's servers, bindings and
// secrets a compile reads. The OpenClaw adapter compiles them into `mcp.servers`
// (runtimes/openclaw/openclaw-config/mcp-servers.js).

/**
 * The compiled name of a server with agent placeholders for one agent, also that
 * agent's tool prefix: the server's name (cut to 21 characters) and a hash of the
 * server and agent ids, at most OpenClaw's 30 characters (docs/mcp.md#agent-placeholders).
 */
export const agentServerName = (server, assistantId) =>
  `${String(server.name).slice(0, 21)}-${createHash("sha256")
    .update(`${server.id}\0${assistantId}`)
    .digest("hex")
    .slice(0, 8)}`;

/** Archived agents get no MCP servers; any other agent through its own bindings. */
export function mcpEligible(profile) {
  return !!profile?.runtimeAgentId && !profile.archivedAt;
}

/**
 * Reads what a Gateway start compiles from the MCP server store. Never throws: a
 * store that cannot be read compiles no servers; a server whose secrets cannot be
 * read gets `null` secrets and is skipped by mcpSections.
 * - `servers`: stored definitions (unredacted URL), ordered by name.
 * - `bindings`: `{ [assistantId]: serverId[] }` for `agent` targets.
 * - `secrets`: `{ [serverId]: { headers, env } | null }` for bound servers.
 * - `redirectUrl`: the OAuth redirect URL (oauthRedirect), read by the caller at
 *   each call so a changed origin reaches the next start or live apply.
 * - `workspaces`, `pathCheck`: the Gateway's workspace root and the folder check for
 *   servers with agent placeholders (mcpSections).
 * `inherited()` adds the servers members use through their lead
 * (`{ [assistantId]: serverId[] }`, lead-shares.js mcpBindings): compiled like the
 * member's own bindings, placeholder servers per member included.
 * `extra(names)` adds servers AgentPier manages itself in the same shape (the agents'
 * GitHub servers, agent-github.js mcpInputs); `names` are the store's, which win.
 * `proxy` (`{ url, credentialFor(serverId), held(serverId) }`): AgentPier's MCP proxy;
 * an OAuth server whose login AgentPier holds compiles through it (proxiedServers).
 */
export function readMcpInputs(
  store,
  {
    redirectUrl = null,
    extra = null,
    workspaces = null,
    inherited = null,
    proxy = null,
  } = {},
) {
  const inputs = proxiedServers(
    readStoreInputs(store, redirectUrl, inherited, proxy),
    proxy,
  );
  // Agent placeholders resolve below the Gateway's workspace root; each resolved
  // path is checked on disk at every compile (agent-folders.js).
  Object.assign(inputs, { workspaces, pathCheck: safeAgentPath });
  if (!extra || inputs.unreadable) return inputs;
  try {
    const more = extra(new Set(inputs.servers.map((server) => server.name)));
    inputs.servers.push(...more.servers);
    Object.assign(inputs.secrets, more.secrets);
    for (const [id, ids] of Object.entries(more.bindings))
      inputs.bindings[id] = [...(inputs.bindings[id] || []), ...ids];
  } catch {
    // Managed servers that cannot be read are left out, like an unreadable value.
  }
  return inputs;
}

/**
 * The store's agent bindings with `inherited()` merged in; an inherited list that
 * cannot be read adds nothing.
 */
export function withInherited(bindings, inherited) {
  if (!inherited) return bindings;
  let more = {};
  try {
    more = inherited() || {};
  } catch {
    return bindings;
  }
  const out = { ...bindings };
  for (const [id, ids] of Object.entries(more))
    out[id] = [...new Set([...(out[id] || []), ...ids])];
  return out;
}

/**
 * The OAuth servers whose login AgentPier holds (mcp-oauth-agentpier.js) as plain
 * HTTP servers of their own transport: the proxy's `/mcp/<id>` URL with the proxy credential of
 * that server as their `Authorization` header (mcp-proxy.js). Both runtimes compile
 * them like any server with headers and never see an OAuth token. Pure.
 */
/** Transports the MCP proxy carries: Streamable HTTP and the legacy HTTP+SSE. */
export const proxyable = (server) => ["http", "sse"].includes(server?.transport);

export function proxiedServers(inputs, proxy) {
  if (!proxy?.url || inputs.unreadable) return inputs;
  inputs.servers = inputs.servers.map((server) => {
    if (server.auth !== "oauth" || !proxyable(server) || !proxy.held(server.id))
      return server;
    if (Object.hasOwn(inputs.secrets, server.id))
      inputs.secrets[server.id] = {
        headers: { Authorization: `Bearer ${proxy.credentialFor(server.id)}` },
        env: {},
      };
    return {
      ...server,
      auth: "headers",
      oauthScope: null,
      url: `${proxy.url}/mcp/${server.id}`,
    };
  });
  return inputs;
}

function readStoreInputs(store, redirectUrl, inherited, proxy) {
  const inputs = {
    servers: [],
    bindings: {},
    secrets: {},
    unreadable: false,
    redirectUrl,
  };
  if (!store) return inputs;
  try {
    // An OAuth server whose old login still awaits its logout is left out, like an
    // unbound one, until that logout went through (McpOAuthLogins.drain).
    const deferred = store.deferredLogouts?.() || [];
    inputs.servers = store.definitions().filter(
      (s) =>
        !(
          s.auth === "oauth" &&
          // A proxied server never uses OpenClaw's old login of its name and URL.
          !(proxy?.url && s.transport === "http" && proxy.held(s.id)) &&
          deferred.some((t) => t.name === s.name && t.url === s.url)
        ),
    );
    inputs.bindings = withInherited(store.bindingsByTarget("agent"), inherited);
  } catch {
    return { servers: [], bindings: {}, secrets: {}, unreadable: true, redirectUrl };
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
