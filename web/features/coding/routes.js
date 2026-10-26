// Coding › CLIs & Erweiterungen:
//   /coding/clis?tab=install|accounts|extensions|mcp
//   /coding/clis/extensions[/:profileId]?tab=skills|plugins|marketplaces|subagents[&install=<entry>]
import { accountItemPattern } from "../accounts/routes.js";

export const codingTabs = ["install", "accounts", "extensions", "mcp"];
export const defaultCodingTab = "install";
// The extension kinds of one CLI profile; "subagents" are the CLI agent definitions.
export const codingExtensionTabs = ["skills", "plugins", "marketplaces", "subagents"];
export const defaultCodingExtensionTab = "skills";
// Older names: the extensions page called subagents "agents"; MCP moved to Zugänge.
const legacyExtensionTabs = { agents: "subagents", mcp: "skills" };
export const mcpClis = ["codex", "claude", "opencode"];
const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const authorizationPattern = /^[A-Za-z0-9_-]{1,200}$/;
// An Agency catalog entry id (path segments joined by "__", see server/features/agency).
export const subagentEntryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** A requested extension tab with old names mapped; unknown tabs open Skills. */
export function readCodingExtensionTab(requested) {
  const tab = Object.hasOwn(legacyExtensionTabs, requested ?? "")
    ? legacyExtensionTabs[requested]
    : requested;
  return codingExtensionTabs.includes(tab) ? tab : defaultCodingExtensionTab;
}

/** The MCP access tab's fields: consent request, setup CLI and grant page. */
export function readCodingMcpQuery(search) {
  const query = new URLSearchParams(search);
  const authorization = query.get("authorization") || "";
  const page = query.get("page") || "1";
  return {
    mcpAuthorization: authorizationPattern.test(authorization) ? authorization : "",
    mcpCli: mcpClis.includes(query.get("cli")) ? query.get("cli") : "codex",
    mcpPage: /^[1-9]\d{0,4}$/.test(page) ? Number(page) : 1,
  };
}

// `install` opens a subagent's install preview (the agents hub's "Als Unteragent in
// CLI installieren …"); it belongs to the Unteragenten tab only.
function extensionsRoute(profileId, search) {
  const query = new URLSearchParams(search);
  const extensionTab = readCodingExtensionTab(query.get("tab"));
  const install = query.get("install") || "";
  return {
    view: "coding",
    codingTab: "extensions",
    profileId,
    extensionTab,
    ...(extensionTab === "subagents" && subagentEntryPattern.test(install)
      ? { install }
      : {}),
  };
}

/** The coding route of a path, `{ view: "missing" }` for a bad profile, else null. */
export function readCodingRoute(pathname, search) {
  const extensions = /^\/coding\/clis\/extensions(?:\/([^/]+))?$/.exec(pathname);
  if (extensions) {
    if (extensions[1] && !profilePattern.test(extensions[1])) return { view: "missing" };
    return extensionsRoute(extensions[1] || "", search);
  }
  if (pathname !== "/coding/clis") return null;
  const query = new URLSearchParams(search);
  const tab = codingTabs.includes(query.get("tab")) ? query.get("tab") : defaultCodingTab;
  if (tab === "extensions") return extensionsRoute("", "");
  if (tab === "mcp")
    return { view: "coding", codingTab: tab, ...readCodingMcpQuery(search) };
  if (tab === "accounts") {
    const item = query.get("item") || "";
    return {
      view: "coding",
      codingTab: tab,
      ...(item && accountItemPattern.test(item) ? { item } : {}),
    };
  }
  return { view: "coding", codingTab: tab };
}

export function codingRoutePath(route) {
  const tab = codingTabs.includes(route.codingTab) ? route.codingTab : defaultCodingTab;
  const query = new URLSearchParams();
  if (tab === "extensions") {
    const kind = readCodingExtensionTab(route.extensionTab);
    if (kind !== defaultCodingExtensionTab) query.set("tab", kind);
    if (kind === "subagents" && subagentEntryPattern.test(route.install || ""))
      query.set("install", route.install);
    const profile = route.profileId ? `/${encodeURIComponent(route.profileId)}` : "";
    return `/coding/clis/extensions${profile}${query.size ? `?${query}` : ""}`;
  }
  if (tab !== defaultCodingTab) query.set("tab", tab);
  if (tab === "accounts" && route.item && accountItemPattern.test(route.item))
    query.set("item", route.item);
  if (tab === "mcp") {
    if (route.mcpAuthorization) query.set("authorization", route.mcpAuthorization);
    if (route.mcpCli && route.mcpCli !== "codex") query.set("cli", route.mcpCli);
    if (route.mcpPage > 1) query.set("page", String(route.mcpPage));
  }
  return `/coding/clis${query.size ? `?${query}` : ""}`;
}

/** A coding route for one tab, e.g. from a menu entry or a "… einrichten" link. */
export const codingRoute = (codingTab = defaultCodingTab, fields = {}) => ({
  view: "coding",
  codingTab,
  ...(codingTab === "extensions"
    ? { profileId: "", extensionTab: defaultCodingExtensionTab }
    : {}),
  ...(codingTab === "mcp" ? readCodingMcpQuery("") : {}),
  ...fields,
});
