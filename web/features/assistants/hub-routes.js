// The agents hub: /agents?tab=all|teams|templates|runtime[&section=advanced]
export const agentsHubTabs = ["all", "teams", "templates", "runtime"];
export const defaultAgentsHubTab = "all";
// Groups of the Runtime tab a link can scroll to.
export const agentsRuntimeSections = ["advanced"];

/** `{ agentsTab?, agentsSection? }` of a hub query; the default tab is left out. */
export function readAgentsHubQuery(search) {
  const query = new URLSearchParams(search);
  const tab = query.get("tab");
  if (!agentsHubTabs.includes(tab) || tab === defaultAgentsHubTab) return {};
  const section = query.get("section");
  return {
    agentsTab: tab,
    ...(tab === "runtime" && agentsRuntimeSections.includes(section)
      ? { agentsSection: section }
      : {}),
  };
}

/** The hub's query string, "" for All agents. */
export function agentsHubQuery(route) {
  const tab = agentsHubTabs.includes(route.agentsTab)
    ? route.agentsTab
    : defaultAgentsHubTab;
  if (tab === defaultAgentsHubTab) return "";
  const query = new URLSearchParams({ tab });
  if (tab === "runtime" && agentsRuntimeSections.includes(route.agentsSection))
    query.set("section", route.agentsSection);
  return `?${query}`;
}

/** A hub route for one tab (`section` only on Runtime). */
export const agentsHubRoute = (tab = defaultAgentsHubTab, section = "") => ({
  view: "agents",
  ...(agentsHubTabs.includes(tab) && tab !== defaultAgentsHubTab
    ? { agentsTab: tab }
    : {}),
  ...(tab === "runtime" && agentsRuntimeSections.includes(section)
    ? { agentsSection: section }
    : {}),
});
