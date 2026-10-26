import { cliSupport, cliTarget } from "../mcp-servers/cli-support.js";

// Long-list items (long-list.js) for SSH/SFTP accesses and MCP servers, built from the
// lists, GET /connections/usage, GET /accounts/usage and GET /connections/problems.
// Unknown usage stays unknown (null), never a fake "not used".

export const globalProject = "__global";

/** Whether anything uses an entry: true, false, or null when a source is unknown. */
export function usedState(parts) {
  if (parts.some((part) => typeof part === "number" && part > 0)) return true;
  if (parts.some((part) => part === null || part === undefined)) return null;
  return false;
}

const count = (list) => (Array.isArray(list) ? list.length : null);

export function sshEndpoint(access) {
  const remote = access.remoteRoot ? ` · ${access.remoteRoot}` : "";
  return `${access.username}@${access.host}:${access.port}${remote}`;
}

/** The last connection test as a status: ok, failed, hostKey (changed) or untested. */
export function sshStatus(access) {
  const test = access.lastTest;
  if (!test) return "untested";
  if (test.ok) return "ok";
  return test.hostKeyMismatch ? "hostKey" : "failed";
}

/** The agent ids an SSH host's usage names (grants, lead shares and hooks). */
const agentIds = (agents) => [...new Set((agents || []).map((agent) => agent.id))];

export function sshItems({ accesses, usage, ownerName }) {
  const hosts = usage?.ssh ?? null;
  return (accesses || []).map((access) => {
    const entry = hosts ? (hosts[access.id] ?? null) : null;
    const status = sshStatus(access);
    return {
      id: access.id,
      name: access.name,
      sub: sshEndpoint(access),
      kind: access.type === "sftp" ? "sftp" : "ssh",
      group: { key: access.projectId || globalProject, label: ownerName(access) },
      status,
      problem: status === "failed" || status === "hostKey",
      usage: entry,
      used: entry
        ? usedState([count(entry.agents), count(entry.hooks), entry.sessions])
        : null,
      lastUsedAt: entry?.lastUsedAt ?? null,
      changedAt: access.updatedAt || access.createdAt || null,
      search: [
        access.name,
        access.host,
        access.username,
        `${access.username}@${access.host}`,
        access.keyName,
        access.remoteRoot,
      ],
      facets: {
        project: access.projectId || globalProject,
        type: access.type === "sftp" ? "sftp" : "ssh",
        agent: agentIds(entry?.agents),
        status,
      },
      record: access,
    };
  });
}

// MCP "Quelle" groups, in their display order.
export const mcpSources = ["remote", "package", "command"];
export const mcpSource = (server) =>
  server.source ? "package" : server.transport === "stdio" ? "command" : "remote";

/** Where an MCP server comes from: the address, the package or the command. */
export function mcpLocation(server) {
  if (server.source)
    return [server.source.registry, server.source.name, server.source.version]
      .filter(Boolean)
      .join(" ");
  if (server.transport === "stdio")
    return [server.command, ...(server.args || [])].filter(Boolean).join(" ");
  return server.url || "";
}

const mcpReasonOrder = ["installFailed", "cliError", "loginRequired", "updateAvailable"];

/** The first problem or warning reason of a server, or "ok". */
export function mcpStatus(reasons) {
  return mcpReasonOrder.find((reason) => reasons.includes(reason)) || "ok";
}

/** Problem and warning reasons per id of one GET /connections/problems category. */
export function reasonsById(category) {
  const map = new Map();
  if (!category || typeof category !== "object") return null;
  for (const entry of [...(category.problems || []), ...(category.warnings || [])])
    map.set(entry.id, [...(map.get(entry.id) || []), ...(entry.reasons || [])]);
  return map;
}

export function mcpItems({ servers, accountUsage, connectionUsage, problems, updates }) {
  const reasons = reasonsById(problems?.mcp);
  const used = accountUsage?.mcpServers ?? null;
  const changes = connectionUsage?.mcp ?? null;
  return (servers || []).map((server) => {
    const own = [...(reasons?.get(server.id) || [])];
    // A directory update the list already asked for counts like the stored warning.
    if (updates?.get(server.id)?.version && !own.includes("updateAvailable"))
      own.push("updateAvailable");
    const entry = used ? (used[server.id] ?? null) : null;
    const clis = server.clis || [];
    const status = mcpStatus(own);
    return {
      id: server.id,
      name: server.name,
      sub: mcpLocation(server),
      kind: server.transport,
      group: { key: mcpSource(server), order: mcpSources.indexOf(mcpSource(server)) },
      status,
      problem: status !== "ok",
      usage: entry,
      used: clis.length
        ? true
        : entry
          ? usedState([
              count(entry.agents),
              entry.sessions,
              count(entry.pipelineProfiles),
            ])
          : null,
      lastUsedAt: null,
      changedAt: changes ? (changes[server.id]?.changedAt ?? null) : null,
      search: [
        server.name,
        server.url,
        server.command,
        ...(server.args || []),
        server.source?.name,
      ],
      facets: {
        transport: server.transport,
        cli: clis,
        agent: agentIds(entry?.agents),
        status,
        source: mcpSource(server),
      },
      record: server,
    };
  });
}

/** The CLIs a server gets: its own plus the chosen ones it supports. */
export function boundClis(server, chosen) {
  const target = cliTarget(server);
  const added = chosen.filter((cli) => cliSupport(cli, target).supported);
  return {
    clis: [...new Set([...(server.clis || []), ...added])],
    unsupported: chosen.filter((cli) => !added.includes(cli)),
  };
}
