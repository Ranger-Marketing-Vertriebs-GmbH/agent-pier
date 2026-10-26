// Until the redesigned pages exist, the new areas are shown by today's pages. A route
// of a new area (the agents hub's Runtime and Templates tabs) maps to the route
// today's page understands, so every old and new address renders the same content.
// Pages receive this route; the address keeps the new one. Zugänge
// (web/features/connections/ConnectionsPage.jsx) and Coding
// (web/features/coding/CodingPage.jsx) have their own pages.
import { readSettingsRoute } from "../features/operations/routes.js";
import { canonicalRoute } from "./route-redirects.js";

const settingsScreen = (section, route, fields = {}) => ({
  ...readSettingsRoute(`/settings/${section}`, ""),
  ...fields,
  ...(route.returnTo ? { returnTo: route.returnTo } : {}),
});
function agentsScreen(route) {
  if (route.assistantId || route.creating || !route.agentsTab) return route;
  if (route.agentsTab === "runtime")
    return settingsScreen(
      route.agentsSection === "advanced" ? "assistants-advanced" : "assistants",
      route,
    );
  // Agency templates live on a CLI profile's Unteragenten tab today.
  if (route.agentsTab === "templates")
    return {
      view: "coding",
      codingTab: "extensions",
      profileId: "",
      extensionTab: "subagents",
    };
  return { view: "agents" };
}

/**
 * The route today's page renders for `route`; other routes are returned as they are.
 * A moved page's old route is first read as its new place.
 */
export function screenRoute(input) {
  const route = input && canonicalRoute(input);
  if (route?.view === "agents") return agentsScreen(route);
  return route;
}

/** The page that renders any route, old or new: for guards that compare pages. */
export const screenOf = (route) => (route ? screenRoute(route) : route);
