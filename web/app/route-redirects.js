// Pages that moved to the new areas (navigation redesign): today's route objects,
// parsed from old addresses or built by pages that still link the old way, become
// routes of their new place. Every field the old route carried is kept, including
// `returnTo` and an MCP OAuth result.
import { readCodingExtensionTab } from "../features/coding/routes.js";

const connectionSections = new Set(["ssh", "secrets", "github"]);
const accountSections = new Set(["models", "services", "mcp-servers"]);
const kept = (route, ...fields) =>
  Object.fromEntries(
    fields.filter((field) => route[field] !== undefined).map((f) => [f, route[f]]),
  );

function movedSettings(route) {
  const section = route.settingsSection || "general";
  const returnTo = kept(route, "returnTo");
  if (section === "assistants")
    return { view: "agents", agentsTab: "runtime", ...returnTo };
  if (section === "assistants-advanced")
    return {
      view: "agents",
      agentsTab: "runtime",
      agentsSection: "advanced",
      ...returnTo,
    };
  if (connectionSections.has(section))
    return { view: "connections", section, ...returnTo };
  if (section === "mcp")
    return {
      view: "coding",
      codingTab: "mcp",
      mcpAuthorization: route.mcpAuthorization || "",
      mcpCli: route.mcpCli || "codex",
      mcpPage: route.mcpPage || 1,
      ...returnTo,
    };
  if (section === "general" && route.settingsTab === "access")
    return { view: "connections", ...returnTo };
  return null;
}

function movedAccounts(route) {
  if (route.section === "cli")
    return { view: "coding", codingTab: "accounts", ...kept(route, "item", "returnTo") };
  return {
    view: "connections",
    ...(accountSections.has(route.section)
      ? { section: route.section, ...kept(route, "item", "step") }
      : {}),
    ...kept(route, "returnTo", "mcpOAuth"),
  };
}

/** The route of a moved page's new place, or null when `route` did not move. */
export function movedRoute(route) {
  if (route?.view === "settings") return movedSettings(route);
  if (route?.view === "accounts") return movedAccounts(route);
  if (route?.view === "extensions")
    return {
      view: "coding",
      codingTab: "extensions",
      profileId: route.profileId || "",
      extensionTab: readCodingExtensionTab(route.extensionTab),
    };
  return null;
}

/** `route` at its current place: moved pages become their new route. */
export const canonicalRoute = (route) => movedRoute(route) || route;
