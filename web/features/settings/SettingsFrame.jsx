import React from "react";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../../lib/i18n/messages/settings.js";
import { settingsTabs } from "../operations/routes.js";
import { tabRoot } from "./settings-navigation.js";

// A tab root of the settings page: header, the three tabs and the tab's own bar.
export function TabFrame({ frame, bar, children }) {
  return (
    <SettingsShell
      className="settings-page-shell"
      title={commonCopy.settings}
      subtitle={operationsCopy.description}
      description={operationsCopy.description}
      leading="menu"
      onLeading={frame.openNavigation}
      navigationOpen={frame.navigationOpen}
      tabs={
        <UnderlineTabs
          label={operationsCopy.title}
          idPrefix="settings"
          tabs={settingsTabs.map((id) => ({ id, label: operationsCopy.groups[id] }))}
          selected={frame.tab}
          onSelect={(id) => frame.go(tabRoot(id))}
        />
      }
      bar={bar}
    >
      <div
        className="settings-tab-panel"
        role="tabpanel"
        id={`settings-tabpanel-${frame.tab}`}
        aria-labelledby={`settings-tab-${frame.tab}`}
      >
        {children}
      </div>
    </SettingsShell>
  );
}

// One section of a tab; the back button returns to that tab on every width, or to the
// page a cross-link came from (`frame.returnTarget`).
export function SubpageFrame({ frame, title, wide = false, bar, children }) {
  const tab = operationsCopy.groups[frame.tab];
  const origin = frame.returnTarget;
  return (
    <SettingsShell
      className={["settings-page-shell", "settings-subpage", wide ? "wide" : ""]
        .filter(Boolean)
        .join(" ")}
      title={title ?? operationsCopy.sections[frame.section]}
      subtitle={settingsHubCopy.subpageOf(tab)}
      leading="back"
      leadingLabel={origin ? origin.label : settingsHubCopy.backTo(tab)}
      onLeading={origin ? origin.back : () => frame.go(tabRoot(frame.tab))}
      bar={bar}
    >
      {children}
    </SettingsShell>
  );
}
