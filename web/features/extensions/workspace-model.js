import { defaultExtensionTab } from "./routes.js";

/** The tabs of one CLI profile: marketplaces only when the CLI supports them, agents only for shared profiles. */
export function workspaceTabs({ shared, marketplaces, counts = {} }) {
  return [
    { id: "skills", count: counts.skills },
    { id: "plugins", count: counts.plugins },
    ...(marketplaces ? [{ id: "marketplaces", count: counts.marketplaces }] : []),
    ...(shared ? [{ id: "agents", count: counts.agents }] : []),
  ];
}

/**
 * The tab to show for a requested tab. A marketplaces link waits while the CLI's
 * capabilities are unknown (`known === null`) instead of flashing the default.
 */
export function resolveWorkspaceTab(requested, ids, known) {
  const pending = requested === "marketplaces" && known === null;
  return {
    tab: pending || ids.includes(requested) ? requested : defaultExtensionTab,
    pending,
  };
}

/** The tab's primary action: header button on desktop, group-label action on phones. */
export function primaryAction({
  tab,
  tool,
  catalogSupported,
  extensionsReady,
  pluginsReady,
  pluginInstall,
}) {
  if (tab === "plugins")
    return tool === "opencode" && !catalogSupported
      ? { kind: "npm", disabled: !pluginsReady || !pluginInstall }
      : { kind: "discover", disabled: !catalogSupported };
  if (tab === "marketplaces") return { kind: "market", disabled: !pluginsReady };
  if (tab === "agents") return { kind: "catalog", disabled: false };
  return { kind: "skill", disabled: !extensionsReady };
}

const plainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Central MCP servers bound to a CLI, from GET /accounts/usage; null while unknown. */
export function cliServerCount(usage, tool) {
  if (!plainObject(usage?.mcpServers)) return null;
  return Object.values(usage.mcpServers).filter(
    (server) =>
      Array.isArray(server?.clis) && server.clis.some((cli) => cli?.tool === tool),
  ).length;
}
