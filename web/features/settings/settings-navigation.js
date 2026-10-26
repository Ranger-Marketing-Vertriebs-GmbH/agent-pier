import {
  defaultSettingsTab,
  readSettingsTab,
  settingsTabOf,
  settingsTabSections,
  settingsTabs,
} from "../operations/routes.js";
import { screenOf } from "../../app/route-screens.js";

// The settings page has tab roots (/settings, /settings?tab=operations), tabs that are
// one section at its own address (/settings/notifications, /users, /remote) and one
// subpage per further section (/settings/<section>); these build and compare routes.
export const tabRoot = (tab) => {
  const id = readSettingsTab(tab);
  if (Object.hasOwn(settingsTabSections, id)) return subpage(settingsTabSections[id]);
  return {
    view: "settings",
    settingsSection: "general",
    settingsTab: settingsTabs.includes(id) ? id : defaultSettingsTab,
  };
};

export const subpage = (section) => ({
  view: "settings",
  settingsSection: section,
  settingsTab: settingsTabOf(section),
});

/** Whether `section` is the content of its tab (App, Benutzer, Fernzugriff). */
export const isTabSection = (section) =>
  Object.values(settingsTabSections).includes(section);

/** `{ section, tab }` of a settings route; a real section decides its tab. */
export function settingsLocation(route) {
  const section = route?.settingsSection || "general";
  if (section !== "general") return { section, tab: settingsTabOf(section) };
  return {
    section,
    tab: settingsTabs.includes(route?.settingsTab)
      ? route.settingsTab
      : defaultSettingsTab,
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
  (section, tab = defaultSettingsTab) =>
  (request) => {
    // Moved sections (Zugänge, Coding, agents Runtime) compare as their settings page.
    const next = screenOf(request?.next);
    if (next?.view !== "settings") return false;
    const location = settingsLocation(next);
    return (
      location.section === section && (section !== "general" || location.tab === tab)
    );
  };
