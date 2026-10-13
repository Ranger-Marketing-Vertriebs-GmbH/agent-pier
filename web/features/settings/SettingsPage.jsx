import React from "react";
import useReturnTarget from "../../app/useReturnTarget.js";
import SettingsSubpage from "./SettingsSubpage.jsx";
import WorkspaceTab from "./WorkspaceTab.jsx";
import { AccessTab, OperationsTab } from "./SummaryTabs.jsx";
import { mergeSettingsRoute, settingsLocation } from "./settings-navigation.js";
import "../operations/operations.css";
import "./settings-page.css";

// Tabs Arbeitsbereich / Zugriff / Betrieb; every section is a subpage of its tab.
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
  // Opened through a cross-link (`returnTo`): a subpage's back arrow returns there.
  const returnTarget = useReturnTarget(route, onNavigate);
  const frame = {
    section,
    tab,
    returnTarget,
    openNavigation,
    navigationOpen,
    go: (next, replace = false) => onNavigate(next, replace),
    navigate: (changes, replace = false) =>
      onNavigate(mergeSettingsRoute(route, changes), replace),
  };
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
  if (tab === "access") return <AccessTab frame={frame} />;
  if (tab === "operations") return <OperationsTab frame={frame} />;
  return <WorkspaceTab frame={frame} state={state} refresh={refresh} ready={ready} />;
}
