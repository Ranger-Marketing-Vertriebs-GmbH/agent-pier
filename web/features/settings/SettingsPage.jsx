import React from "react";
import SettingsSubpage, { SectionTab } from "./SettingsSubpage.jsx";
import WorkspaceTab from "./WorkspaceTab.jsx";
import { OperationsTab } from "./SummaryTabs.jsx";
import {
  isTabSection,
  mergeSettingsRoute,
  settingsLocation,
} from "./settings-navigation.js";
import "../operations/operations.css";
import "./settings-page.css";

// Tabs Allgemein · App & Benachrichtigungen · Benutzer · Fernzugriff · Betrieb. App,
// Benutzer and Fernzugriff show their one section; every other section is a subpage of
// its tab.
export default function SettingsPage({
  state,
  refresh,
  ready,
  route,
  onNavigate,
  openNavigation,
  navigationOpen,
}) {
  const { section, tab } = settingsLocation(route);
  const frame = {
    section,
    tab,
    // A subpage opened through a cross-link (`returnTo`) leads back there.
    route,
    openNavigation,
    navigationOpen,
    go: (next, replace = false) => onNavigate(next, replace),
    navigate: (changes, replace = false) =>
      onNavigate(mergeSettingsRoute(route, changes), replace),
  };
  // Opened through a cross-link, a tab's section keeps the back arrow to its origin.
  if (isTabSection(section) && !route.returnTo)
    return <SectionTab section={section} route={route} state={state} frame={frame} />;
  if (section !== "general")
    return (
      <SettingsSubpage
        key={section}
        section={section}
        route={route}
        state={state}
        frame={frame}
      />
    );
  if (tab === "operations") return <OperationsTab frame={frame} />;
  return <WorkspaceTab frame={frame} state={state} refresh={refresh} ready={ready} />;
}
