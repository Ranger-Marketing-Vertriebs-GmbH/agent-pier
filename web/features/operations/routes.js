const sections = new Set([
  "notifications",
  "diagnostics",
  "backups",
  "updates",
  "audit",
  "mcp",
]);
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
    auditBefore: /^[1-9]\d{0,18}$/.test(before) ? before : "",
    operationId: identity.test(job) ? job : "",
  };
}
export function settingsRoutePath(route) {
  const section = route.settingsSection || "general",
    query = new URLSearchParams();
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
      ["auditBefore", "before"],
    ])
      if (route[field]) query.set(name, route[field]);
  } else if (route.operationId) query.set("job", route.operationId);
  return `/settings${section === "general" ? "" : "/" + section}${query.size ? "?" + query : ""}`;
}
