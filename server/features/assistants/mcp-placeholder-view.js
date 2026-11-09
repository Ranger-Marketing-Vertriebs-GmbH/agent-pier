import {
  agentFolders,
  placeholderBase,
  resolvePlaceholder,
} from "../mcp-servers/agent-placeholders.js";
import { safeAgentPath } from "./agent-folders.js";
import { agentServerName, mcpEligible } from "../mcp-servers/mcp-inputs.js";
import { chatPlaceholderFolders } from "./chat-file-folders.js";

/**
 * What a server with agent placeholders resolves to for each bound agent, for the
 * owner's server overview (docs/mcp.md#agent-placeholders). Each value is a path below
 * that agent's own folder; secret settings never appear (placeholderTemplates holds
 * only placeholder values). `status`: `active` while the running Gateway carries the
 * agent's entry, `pending` until it does, `unsafe` when a folder on the way is a link
 * or a file (the agent gets no entry), `unavailable` without a workspace root.
 * `ownRuntime(profile)`: for an agent on a runtime of its own process set (Hermes),
 * `{ workspace, ready }`: its work folder and whether its set runs with its current
 * home; such an agent's entry keeps the server's name. Null for any other agent.
 */
export function placeholderViews(
  list,
  {
    profiles = [],
    bindings = {},
    workspaces = null,
    running = null,
    pathCheck = safeAgentPath,
    ownRuntime = () => null,
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
        const own = ownRuntime(profile);
        const entry = own ? String(server.name) : agentServerName(server, profile.id);
        const base = { id: profile.id, name: profile.name, entry };
        // A Hermes agent's work folder (its terminal.cwd) and chat folders, the
        // latter withheld on a shared one (runtimes/hermes/hermes-config/mcp.js).
        const folders = own
          ? chatPlaceholderFolders(own.workspace, { shared: own.shared })
          : agentFolders(workspaces, profile.id);
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
        ];
        if (items.some((item) => item.resolved === false))
          return { ...base, status: "unavailable", values: [] };
        const resolvedItems = items.filter((item) => item.resolved);
        const safe = resolvedItems.every((item) =>
          pathCheck(item.resolved.path, placeholderBase(folders, item.resolved.path)),
        );
        return {
          ...base,
          status: !safe
            ? "unsafe"
            : (own ? own.ready : compiled.has(entry))
              ? "active"
              : "pending",
          values: resolvedItems.map(({ resolved, ...item }) => ({
            ...item,
            value: resolved.value,
          })),
        };
      });
    return { ...server, agentFolders: agents };
  });
}
