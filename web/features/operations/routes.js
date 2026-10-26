export const sections = new Set([
  "assistants",
  // Nested below the agent service; it belongs to the workspace tab but is no row there.
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
  // Restricted users and their agents (Settings › Access › Users).
  "users",
  // The component gallery, below the Development group of the operations tab.
  "components",
]);
export const settingsTabs = ["workspace", "access", "operations"];
// The settings sections each tab lists; "general" is also the root of every tab.
export const settingsSectionGroups = {
  workspace: ["general", "notifications", "assistants"],
  access: ["mcp", "remote", "ssh", "secrets", "github", "users"],
  operations: ["diagnostics", "backups", "updates", "audit", "components"],
};
export const settingsTabOf = (section) =>
  settingsTabs.find((tab) => settingsSectionGroups[tab].includes(section)) || "workspace";
const identity = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export function readSettingsRoute(pathname, search) {
  const match = /^\/settings(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  if (match[1] && !sections.has(match[1])) return { view: "missing" };
  const query = new URLSearchParams(search),
    rawPage = query.get("page") || "1",
    before = query.get("before") || "",
    job = query.get("job") || "";
  const authorization = query.get("authorization") || "";
  return {
    // One user's detail on the users page (?user=<id>).
    ...(match[1] === "users" && identity.test(query.get("user") || "")
      ? { userId: query.get("user") }
      : {}),
    ...(match[1] === "mcp"
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
    settingsSection: match[1] || "general",
    settingsTab: match[1]
      ? settingsTabOf(match[1])
      : settingsTabs.includes(query.get("tab"))
        ? query.get("tab")
        : "workspace",
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
  const section = route.settingsSection || "general",
    query = new URLSearchParams();
  if (
    section === "general" &&
    settingsTabs.includes(route.settingsTab) &&
    route.settingsTab !== "workspace"
  )
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
