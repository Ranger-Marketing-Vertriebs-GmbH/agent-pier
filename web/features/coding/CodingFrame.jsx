import React from "react";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { codingPageCopy as copy } from "../../lib/i18n/messages/coding.js";
import { codingTabs } from "./routes.js";
import "./coding.css";

export const codingTabPanelId = (tab) => `coding-tabpanel-${tab}`;

/**
 * Coding › CLIs & Erweiterungen: the page header with its four tabs around one tab's
 * content. A phone subpage (an account's detail) replaces the header: it brings its
 * own title and back arrow and hides the tabs.
 */
export default function CodingFrame({
  tab,
  counts = {},
  onTab,
  disabled = false,
  subpage = false,
  className = "",
  title = copy.title,
  subtitle,
  leading = "menu",
  onLeading,
  leadingLabel,
  navigationOpen = false,
  actions,
  bar,
  children,
}) {
  const tabs = codingTabs.map((id) => ({
    id,
    label: copy.tabs[id],
    count: counts[id],
  }));
  return (
    <SettingsShell
      className={["coding-page", className].filter(Boolean).join(" ")}
      title={title}
      subtitle={subtitle}
      description={subpage ? undefined : copy.description}
      leading={leading}
      onLeading={onLeading}
      leadingLabel={leadingLabel}
      navigationOpen={navigationOpen}
      actions={actions}
      bar={bar}
      tabs={
        subpage ? undefined : (
          <UnderlineTabs
            label={copy.tabsLabel}
            tabs={tabs}
            selected={tab}
            onSelect={onTab}
            disabled={disabled}
            idPrefix="coding"
          />
        )
      }
    >
      <section
        role="tabpanel"
        id={codingTabPanelId(tab)}
        aria-labelledby={`coding-tab-${tab}`}
        className="coding-tabpanel"
      >
        {children}
      </section>
    </SettingsShell>
  );
}
