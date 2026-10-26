export const sections = new Set([
  "assistants",
  // Nested below the agent service (now Agenten › Laufzeit › Erweitert).
  "assistants-advanced",
  "notifications",
  "diagnostics",
  "backups",
  "updates",
  "audit",
  "mcp",
  "remote",
  "ssh",
  "secrets",
  "github",
  // Restricted users and their agents (Settings › Users).
  "users",
  // The component gallery, below the Development group of the operations tab.
  "components",
]);
// Tabs Allgemein · App & Benachrichtigungen · Benutzer · Fernzugriff · Betrieb (handoff
// §5.8). App, Benutzer and Fernzugriff show one section each, at its own address.
export const settingsTabs = ["general", "app", "users", "remote", "operations"];
export const defaultSettingsTab = "general";
export const settingsTabSections = {
  app: "notifications",
  users: "users",
  remote: "remote",
};
// Former tab values: Arbeitsbereich is Allgemein; Zugriff moved to Zugänge, so it stays
// recognisable for the redirect (web/app/route-redirects.js).
const legacySettingsTabs = { workspace: "general", access: "access" };
export const readSettingsTab = (value) =>
  settingsTabs.includes(value)
    ? value
    : Object.hasOwn(legacySettingsTabs, value ?? "")
      ? legacySettingsTabs[value]
      : defaultSettingsTab;
// The settings sections each tab lists; "general" is also the root of every tab. The
// sections that moved (agent service, MCP access, SSH, secrets, GitHub) redirect to
// their new place and count as Allgemein, whose "Umgezogen" group links them.
export const settingsSectionGroups = {
  general: [
    "general",
    "assistants",
    "assistants-advanced",
    "mcp",
    "ssh",
    "secrets",
    "github",
  ],
  app: ["notifications"],
  users: ["users"],
  remote: ["remote"],
  operations: ["diagnostics", "backups", "updates", "audit", "components"],
};
export const settingsTabOf = (section) =>
  settingsTabs.find((tab) => settingsSectionGroups[tab].includes(section)) ||
  defaultSettingsTab;
const identity = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export function readSettingsRoute(pathname, search) {
  const match = /^\/settings(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  const query = new URLSearchParams(search);
  // /settings?tab=users is the Benutzer tab, whose address is /settings/users.
  const tab = query.get("tab") || "";
  const section =
    match[1] || (Object.hasOwn(settingsTabSections, tab) ? settingsTabSections[tab] : "");
  if (section && !sections.has(section)) return { view: "missing" };
  const rawPage = query.get("page") || "1",
    before = query.get("before") || "",
    job = query.get("job") || "";
  const authorization = query.get("authorization") || "";
  return {
    // One user's detail on the users page (?user=<id>).
    ...(section === "users" && identity.test(query.get("user") || "")
      ? { userId: query.get("user") }
      : {}),
    ...(section === "mcp"
      ? {
          mcpAuthorization: /^[A-Za-z0-9_-]{1,200}$/.test(authorization)
            ? authorization
            : "",
          mcpCli: ["codex", "claude", "opencode"].includes(query.get("cli"))
            ? query.get("cli")
            : "codex",
          mcpPage: /^[1-9]\d{0,4}$/.test(rawPage) ? Number(rawPage) : 1,
        }
      : {}),
    view: "settings",
    settingsSection: section || "general",
    settingsTab: section ? settingsTabOf(section) : readSettingsTab(query.get("tab")),
    auditPage:
      /^[1-9]\d*$/.test(rawPage) &&
      Number.isSafeInteger(Number(rawPage)) &&
      Number(rawPage) <= 100000
        ? Number(rawPage)
        : 1,
    auditAction: (query.get("action") || "").slice(0, 100),
    auditOutcome: ["success", "failure"].includes(query.get("outcome"))
      ? query.get("outcome")
      : "",
    sessionIdFilter: (query.get("sessionId") || "").slice(0, 80),
    projectIdFilter: (query.get("projectId") || "").slice(0, 80),
    resourceIdFilter: (query.get("resourceId") || "").slice(0, 120),
    auditBefore: /^[1-9]\d{0,18}$/.test(before) ? before : "",
    operationId: identity.test(job) ? job : "",
  };
}
export function settingsRoutePath(route) {
  const tabSection = Object.hasOwn(settingsTabSections, route.settingsTab ?? "")
    ? settingsTabSections[route.settingsTab]
    : "";
  const own = route.settingsSection && route.settingsSection !== "general";
  const section = own ? route.settingsSection : tabSection || "general",
    query = new URLSearchParams();
  // Only tabs without an address of their own carry ?tab= (and the former Zugriff tab
  // until it is redirected).
  if (section === "general" && ["operations", "access"].includes(route.settingsTab))
    query.set("tab", route.settingsTab);
  if (section === "mcp") {
    if (route.mcpAuthorization) query.set("authorization", route.mcpAuthorization);
    if (route.mcpCli && route.mcpCli !== "codex") query.set("cli", route.mcpCli);
    if (route.mcpPage > 1) query.set("page", String(route.mcpPage));
  } else if (section === "audit") {
    if (route.auditPage > 1) query.set("page", String(route.auditPage));
    for (const [field, name] of [
      ["auditAction", "action"],
      ["auditOutcome", "outcome"],
      ["sessionIdFilter", "sessionId"],
      ["projectIdFilter", "projectId"],
      ["resourceIdFilter", "resourceId"],
      ["auditBefore", "before"],
    ])
      if (route[field]) query.set(name, route[field]);
  } else if (section === "users") {
    if (route.userId) query.set("user", route.userId);
  } else if (route.operationId) query.set("job", route.operationId);
  return `/settings${section === "general" ? "" : "/" + section}${query.size ? "?" + query : ""}`;
}
