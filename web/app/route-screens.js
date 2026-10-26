// Every area of the redesign has its own page: Zugänge
// (web/features/connections/ConnectionsPage.jsx), Coding
// (web/features/coding/CodingPage.jsx) and the agents hub
// (web/features/assistants/hub/AgentsHub.jsx). A moved page's old route is read as its
// new place, so every old and new address renders the same content.
import { canonicalRoute } from "./route-redirects.js";

/**
 * The route the rendering page receives for `route`: a moved page's old route is read
 * as its new place; other routes are returned as they are.
 */
export function screenRoute(input) {
  return input && canonicalRoute(input);
}

/** The page that renders any route, old or new: for guards that compare pages. */
export const screenOf = (route) => (route ? screenRoute(route) : route);
