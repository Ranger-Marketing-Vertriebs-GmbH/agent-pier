// Agent settings tabs and their subpages: /agents/:id/settings?tab=…&page=…
//
// Seven tabs by purpose (handoff 5.4). Older names keep working: `profile` → identity,
// `work` → access, team or overview, `routines` → automation, `telegram` → channels.
export const agentTabs = [
  "overview",
  "identity",
  "capabilities",
  "access",
  "team",
  "automation",
  "channels",
];
// Kept as an alias of `agentTabs` for callers that name the redesign.
export const agentSettingsTabs = agentTabs;
export const legacyAgentTabs = ["profile", "work", "routines", "telegram"];
export const defaultAgentSettingsTab = "overview";
// Each subpage belongs to one tab; a valid page decides the tab.
export const agentPages = {
  memory: "capabilities",
  allowlist: "capabilities",
  skills: "capabilities",
  actions: "overview",
  projects: "access",
  pipelines: "access",
  ssh: "access",
  github: "access",
  secrets: "access",
  hook: "automation",
  "telegram-activity": "channels",
  "telegram-connection": "channels",
};
export const agentPageTabs = agentPages;
const renamedTab = {
  profile: "identity",
  routines: "automation",
  telegram: "channels",
};
const pageOf = (value) => (Object.hasOwn(agentPages, value ?? "") ? value : "");
// A team focused in the team list (`team=<id>`), linked from the chat notes.
const teamPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const validTeam = (value) => teamPattern.test(value ?? "");

/**
 * The tab of a route (`agentTab` may hold an old or a new name): a valid page decides
 * it; `work` becomes team with a focused team, otherwise overview.
 */
export function agentSettingsTab(route) {
  const page = pageOf(route.agentPage);
  if (page) return agentPages[page];
  const tab = route.agentTab;
  if (agentTabs.includes(tab)) return tab;
  if (tab === "work") return validTeam(route.agentTeam) ? "team" : "overview";
  return Object.hasOwn(renamedTab, tab ?? "") ? renamedTab[tab] : defaultAgentSettingsTab;
}

/** `{ tab, page }` the page shows; missing fields mean the defaults. */
export function agentSettingsLocation(route) {
  const page = pageOf(route.agentPage);
  return { tab: agentSettingsTab(route), page };
}

const focusTeam = (tab, page, value) =>
  tab === "team" && !page && validTeam(value) ? value : "";

// The hook an automation subpage shows (`page=hook&hook=<uuid>`).
const hookPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const focusHook = (page, value) =>
  page === "hook" && hookPattern.test(value ?? "") ? value : "";

// The default tab stays out of the address unless a link names it or a subpage
// (`tab=work` becomes `tab=overview`, a plain link stays plain).
const namesDefault = (route) =>
  ["overview", "work"].includes(route.agentTab) &&
  agentSettingsTab({ ...route, agentPage: "" }) === "overview";

function settingsFields(route) {
  const page = pageOf(route.agentPage);
  const tab = agentSettingsTab(route);
  return {
    tab,
    shown: tab !== defaultAgentSettingsTab || !!page || namesDefault(route),
    page,
    team: focusTeam(tab, page, route.agentTeam),
    hook: focusHook(page, route.agentHook),
  };
}

/** Route fields from the query; defaults are left out so plain links stay equal. */
export function readAgentSettingsQuery(search) {
  const query = new URLSearchParams(search);
  const { tab, shown, page, team, hook } = settingsFields({
    agentTab: query.get("tab"),
    agentPage: query.get("page"),
    agentTeam: query.get("team"),
    agentHook: query.get("hook"),
  });
  return {
    ...(shown ? { agentTab: tab } : {}),
    ...(page ? { agentPage: page } : {}),
    ...(team ? { agentTeam: team } : {}),
    ...(hook ? { agentHook: hook } : {}),
  };
}

export function agentSettingsQuery(route) {
  const { tab, shown, page, team, hook } = settingsFields(route);
  const query = new URLSearchParams();
  if (shown) query.set("tab", tab);
  if (page) query.set("page", page);
  if (team) query.set("team", team);
  if (hook) query.set("hook", hook);
  return query.size ? `?${query}` : "";
}

/** The agent's Team tab with one of the lead's teams opened in its team list. */
export const agentTeamRoute = (assistantId, teamId) => ({
  view: "agents",
  assistantId,
  agentSettings: true,
  agentTab: "team",
  agentTeam: teamId,
});
