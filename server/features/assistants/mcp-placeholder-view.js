import { agentFolders, resolvePlaceholder } from "../mcp-servers/agent-placeholders.js";
import { safeAgentPath } from "./openclaw-config/agent-folders.js";
import { agentServerName, mcpEligible } from "./openclaw-config/mcp-servers.js";

/**
 * What a server with agent placeholders resolves to for each bound agent, for the
 * owner's server overview (docs/mcp.md#agent-placeholders). Each value is a path below
 * that agent's own folder; secret settings never appear (placeholderTemplates holds
 * only placeholder values). `status`: `active` while the running Gateway carries the
 * agent's entry, `pending` until it does, `unsafe` when a folder on the way is a link
 * or a file (the agent gets no entry), `unavailable` without a workspace root.
 */
export function placeholderViews(
  list,
  {
    profiles = [],
    bindings = {},
    workspaces = null,
    running = null,
    pathCheck = safeAgentPath,
  },
) {
  const compiled = new Set(running?.servers || []);
  return list.map((server) => {
    if (server.agentPlaceholders !== true || !server.placeholders) return server;
    const templates = server.placeholders;
    const agents = profiles
      .filter(
        (profile) =>
          mcpEligible(profile) && (bindings[profile.id] || []).includes(server.id),
      )
      .map((profile) => {
        const entry = agentServerName(server, profile.id);
        const base = { id: profile.id, name: profile.name, entry };
        const folders = agentFolders(workspaces, profile.id);
        if (!folders) return { ...base, status: "unavailable", values: [] };
        const resolve = (template, prefix = false) =>
          resolvePlaceholder(template, folders, prefix);
        const items = [
          ...templates.args.map(({ index, template }) => ({
            field: "args",
            index,
            resolved: resolve(template, true),
          })),
          ...(templates.cwd ? [{ field: "cwd", resolved: resolve(templates.cwd) }] : []),
          ...Object.entries(templates.env).map(([name, template]) => ({
            field: "env",
            name,
            resolved: resolve(template),
          })),
        ].filter((item) => item.resolved);
        const safe = items.every((item) =>
          pathCheck(item.resolved.path, folders["agent.workspace"]),
        );
        return {
          ...base,
          status: !safe ? "unsafe" : compiled.has(entry) ? "active" : "pending",
          values: items.map(({ resolved, ...item }) => ({
            ...item,
            value: resolved.value,
          })),
        };
      });
    return { ...server, agentFolders: agents };
  });
}
