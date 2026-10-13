import { settingsTabOf, settingsTabs } from "../operations/routes.js";

// The settings page has tab roots (/settings, /settings?tab=…) and one subpage per
// section (/settings/<section>); these build and compare their routes.
export const tabRoot = (tab) => ({
  view: "settings",
  settingsSection: "general",
  settingsTab: settingsTabs.includes(tab) ? tab : "workspace",
});

export const subpage = (section) => ({
  view: "settings",
  settingsSection: section,
  settingsTab: settingsTabOf(section),
});

/** `{ section, tab }` of a settings route; a real section decides its tab. */
export function settingsLocation(route) {
  const section = route?.settingsSection || "general";
  if (section !== "general") return { section, tab: settingsTabOf(section) };
  return {
    section,
    tab: settingsTabs.includes(route?.settingsTab) ? route.settingsTab : "workspace",
  };
}

/** What a subpage's `navigate(changes)` leads to; the tab follows the section. */
export function mergeSettingsRoute(route, changes) {
  const settingsSection = changes.settingsSection ?? route.settingsSection ?? "general";
  return {
    ...route,
    ...changes,
    view: "settings",
    settingsSection,
    settingsTab:
      changes.settingsTab ??
      (settingsSection === "general"
        ? settingsLocation(route).tab
        : settingsTabOf(settingsSection)),
  };
}

/** For useUnsavedChangesGuard: navigations that keep this draft on screen. */
export const staysOn =
  (section, tab = "workspace") =>
  (request) => {
    const next = request?.next;
    if (next?.view !== "settings") return false;
    const location = settingsLocation(next);
    return (
      location.section === section && (section !== "general" || location.tab === tab)
    );
  };
