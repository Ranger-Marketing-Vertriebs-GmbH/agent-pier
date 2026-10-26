// Zugänge: shared credentials, created once and granted where they are used.
// /connections?section=<category>&item=<id|new>[&step=<MCP wizard step>]
import {
  accountItemPattern,
  accountsQuery,
  readAccountsQuery,
} from "../accounts/routes.js";

// The categories in their column order; the first three come from the Accounts hub,
// the others from the former Settings › Access pages.
export const connectionSections = [
  "models",
  "services",
  "mcp-servers",
  "ssh",
  "secrets",
  "github",
];
// Categories whose items and MCP wizard steps follow the Accounts subpage rules.
export const accountConnectionSections = ["models", "services", "mcp-servers"];

/** `{ section, item?, step? }` of a connections query; unknown values are dropped. */
export function readConnectionsQuery(search) {
  const query = new URLSearchParams(search);
  const section = query.get("section");
  if (accountConnectionSections.includes(section)) return readAccountsQuery(search);
  if (!connectionSections.includes(section)) return {};
  const item = query.get("item") || "";
  return { section, ...(accountItemPattern.test(item) ? { item } : {}) };
}

/** The query string of a connections route, or "" for the overview. */
export function connectionsQuery(route) {
  if (accountConnectionSections.includes(route.section)) return accountsQuery(route);
  if (!connectionSections.includes(route.section)) return "";
  const query = new URLSearchParams({ section: route.section });
  if (route.item && accountItemPattern.test(route.item)) query.set("item", route.item);
  return `?${query}`;
}

export const connectionsRoutePath = (route) => `/connections${connectionsQuery(route)}`;

/** A connections route for one category (and item), e.g. from a "… einrichten" link. */
export const connectionsRoute = (section, item) => ({
  view: "connections",
  ...(connectionSections.includes(section) ? { section } : {}),
  ...(section && item ? { item } : {}),
});

/** The activity log filtered to one Zugänge entry ("Im Aktivitätsprotokoll"). */
export const auditRoute = (resourceId) => ({
  view: "settings",
  settingsSection: "audit",
  settingsTab: "operations",
  resourceIdFilter: resourceId,
});
