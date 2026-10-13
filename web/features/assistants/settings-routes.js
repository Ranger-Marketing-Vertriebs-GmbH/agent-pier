// Agent settings tabs and their subpages: /agents/:id/settings?tab=…&page=…
export const agentTabs = ["profile", "capabilities", "work", "telegram"];
// Each subpage belongs to one tab; a valid page decides the tab.
export const agentPages = {
  memory: "capabilities",
  allowlist: "capabilities",
  actions: "work",
  projects: "work",
  pipelines: "work",
  "telegram-activity": "telegram",
  "telegram-connection": "telegram",
};
const pageOf = (value) => (Object.hasOwn(agentPages, value ?? "") ? value : "");

/** `{ tab, page }` of an agent settings route; missing fields mean the defaults. */
export function agentSettingsLocation(route) {
  const page = pageOf(route.agentPage);
  const tab = page
    ? agentPages[page]
    : agentTabs.includes(route.agentTab)
      ? route.agentTab
      : "profile";
  return { tab, page };
}

/** Route fields from the query; defaults are left out so plain links stay equal. */
export function readAgentSettingsQuery(search) {
  const query = new URLSearchParams(search);
  const { tab, page } = agentSettingsLocation({
    agentTab: query.get("tab"),
    agentPage: query.get("page"),
  });
  return {
    ...(tab !== "profile" ? { agentTab: tab } : {}),
    ...(page ? { agentPage: page } : {}),
  };
}

export function agentSettingsQuery(route) {
  const { tab, page } = agentSettingsLocation(route);
  const query = new URLSearchParams();
  if (tab !== "profile") query.set("tab", tab);
  if (page) query.set("page", page);
  return query.size ? `?${query}` : "";
}
