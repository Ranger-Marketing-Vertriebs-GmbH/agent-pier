import React from "react";
import Icon from "../../../components/Icon.jsx";
import SettingsShell from "../../../components/SettingsShell.jsx";
import UnderlineTabs from "../../../components/UnderlineTabs.jsx";
import { routePath } from "../../../app/routes.js";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { agentsHubRoute, agentsHubTabs } from "../hub-routes.js";
import "./hub.css";

export const newAgentRoute = { view: "agents", creating: true };

/**
 * The agents hub's frame (handoff 5.2): header "Agenten" with its lead, "Aus Vorlage"
 * and the primary "Neuer Agent", and the five underline tabs with counts. Each tab
 * renders it around its content and passes its own save bar. `origin` (from a
 * cross-link's `returnTo`) turns the menu button into the way back.
 */
export default function HubFrame({
  tab,
  counts = {},
  navigate,
  openNavigation,
  navigationOpen,
  origin = null,
  actions = true,
  bar,
  children,
}) {
  const link = (route) => ({
    href: routePath(route),
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      event.preventDefault();
      navigate(route);
    },
  });
  return (
    <SettingsShell
      className="settings-page-shell agents-hub"
      title={assistantCopy.title}
      description={copy.lead}
      leading={origin ? "back" : "menu"}
      leadingLabel={origin?.label}
      onLeading={origin ? origin.back : openNavigation}
      navigationOpen={navigationOpen}
      actions={
        actions && (
          <>
            <a className="button secondary" {...link(agentsHubRoute("templates"))}>
              {copy.fromTemplate}
            </a>
            <a className="button primary" {...link(newAgentRoute)}>
              <Icon name="plus" size={15} />
              {assistantCopy.create}
            </a>
          </>
        )
      }
      tabs={
        <UnderlineTabs
          label={copy.tabsLabel}
          idPrefix="agents-hub"
          tabs={agentsHubTabs.map((id) => ({
            id,
            label: copy.tabs[id],
            ...(counts[id] !== undefined ? { count: counts[id] } : {}),
          }))}
          selected={tab}
          onSelect={(id) => navigate(agentsHubRoute(id))}
        />
      }
      bar={bar}
    >
      <div
        className="agents-hub-panel"
        role="tabpanel"
        id={`agents-hub-tabpanel-${tab}`}
        aria-labelledby={`agents-hub-tab-${tab}`}
      >
        {children}
      </div>
    </SettingsShell>
  );
}
