// Agent settings tabs and their subpages: /agents/:id/settings?tab=…&page=…
export const agentTabs = ["profile", "capabilities", "work", "telegram"];
// Each subpage belongs to one tab; a valid page decides the tab.
export const agentPages = {
  memory: "capabilities",
  allowlist: "capabilities",
  skills: "capabilities",
  actions: "work",
  projects: "work",
  pipelines: "work",
  ssh: "work",
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

// A team focused in the Work tab's team list (`team=<id>`), linked from the chat notes.
const teamPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const focusTeam = (tab, page, value) =>
  tab === "work" && !page && teamPattern.test(value ?? "") ? value : "";

/** Route fields from the query; defaults are left out so plain links stay equal. */
export function readAgentSettingsQuery(search) {
  const query = new URLSearchParams(search);
  const { tab, page } = agentSettingsLocation({
    agentTab: query.get("tab"),
    agentPage: query.get("page"),
  });
  const team = focusTeam(tab, page, query.get("team"));
  return {
    ...(tab !== "profile" ? { agentTab: tab } : {}),
    ...(page ? { agentPage: page } : {}),
    ...(team ? { agentTeam: team } : {}),
  };
}

export function agentSettingsQuery(route) {
  const { tab, page } = agentSettingsLocation(route);
  const query = new URLSearchParams();
  if (tab !== "profile") query.set("tab", tab);
  if (page) query.set("page", page);
  const team = focusTeam(tab, page, route.agentTeam);
  if (team) query.set("team", team);
  return query.size ? `?${query}` : "";
}

/** Settings → Work with one of the lead's teams opened in its team list. */
export const agentTeamRoute = (assistantId, teamId) => ({
  view: "agents",
  assistantId,
  agentSettings: true,
  agentTab: "work",
  agentTeam: teamId,
});
