import React from "react";
import Icon from "../../components/Icon.jsx";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { mobileHeaderCopy } from "../../lib/i18n/messages/app.js";
import useAssistants from "./useAssistants.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { activityFor, headerDotTone, headerStatus } from "./assistant-status.js";
import { assistantShellCopy } from "../../lib/i18n/messages/assistant-shell.js";
import { assistantBrowserCopy } from "../../lib/i18n/messages/assistant-browser.js";
import { shellLevel } from "./shell-level.js";
import BrowserPreview from "./browser/BrowserPreview.jsx";
import { browserOffered, browserRoute } from "./browser/browser-entry.js";
import RouteLink from "./RouteLink.jsx";
import "./assistant-shell.css";
import "./assistant-pane.css";
import StatusDot from "../../components/StatusDot.jsx";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";

// One bar for the agent chat and its settings (handoff 1d, 2e, 2f). Below 701px it
// replaces the app's mobile header, so it carries the navigation button itself. In a
// split view's pane (`pane`: { menuItems, close, headerProps }) it has no navigation;
// ⋯ holds the pane's entries and Settings, × takes the pane out of the view.
// `statusExtra` (the agent chat's chat selector) takes the place of "· <model>"; on a
// phone it takes the status word's place too, and the dot alone (labelled with that
// word) shows the status.
// While the agent's browser runs, its live preview opens it; otherwise, while the
// browser capability is on, **Browser** does (labelled on a computer, an icon on a
// phone, an entry of ⋯ in a pane), and the page offers to start it.
export default function AssistantHeader({
  assistant,
  variant,
  navigate,
  onBack,
  openNavigation,
  navigationOpen = false,
  attempt,
  member,
  compacting = false,
  subtitle,
  backLabel,
  actions,
  statusExtra = null,
  pane = null,
  disconnected = false,
}) {
  const menu = useRowMenu();
  const { runtime, models, activity = {} } = useAssistants();
  const status = headerStatus({
    assistant,
    models,
    runtime,
    attempt,
    entry: activityFor(activity, assistant.id),
    member,
    copy,
    compacting,
    disconnected,
  });
  const missing = status.tone === "missing";
  const dotOnly = useMobileLayout() && Boolean(statusExtra) && !missing;
  const settings = variant === "settings";
  const detail = member
    ? `${member.role} · ${assistant.model.modelId}`
    : assistant.model.modelId;
  const shell = shellLevel(assistant);
  const Heading = pane ? "h2" : "h1";
  const openSettings = () =>
    navigate({ view: "agents", assistantId: assistant.id, agentSettings: true });
  const browserEntry =
    !settings && !assistant.browserRunning && browserOffered(assistant);
  const browserLabel = assistantBrowserCopy.entryOpen(assistant.name);
  return (
    <>
      <header
        className={`assistant-header ${variant}${pane ? " in-pane" : ""}`}
        {...pane?.headerProps}
      >
        {openNavigation && !pane && (
          <button
            type="button"
            className="assistant-header-icon assistant-header-menu"
            aria-label={mobileHeaderCopy.iconButtonAriaLabel}
            aria-expanded={navigationOpen}
            onClick={openNavigation}
          >
            <Icon name="menu" />
          </button>
        )}
        {settings && (
          <button
            type="button"
            className="assistant-header-icon"
            aria-label={backLabel || copy.backToChat}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        )}
        <span className="assistant-avatar" aria-hidden="true">
          {avatarGlyph(assistant.name)}
        </span>
        <div className="assistant-header-title">
          <div className="assistant-header-name">
            {/* Several panes share the page: each names its chat one level down. */}
            <Heading>{assistant.name}</Heading>
            {shell !== "off" && (
              <span
                className={`assistant-shell-chip ${shell}`}
                title={assistantShellCopy.badgeLabel(assistantShellCopy.levels[shell])}
              >
                {assistantShellCopy.badge[shell]}
              </span>
            )}
            {assistant.browserRunning && (
              <span className="assistant-shell-chip browser" role="status">
                {assistantBrowserCopy.running}
              </span>
            )}
          </div>
          {/* Agent settings carry their own actions and show the status line. */}
          {settings && !missing && !actions ? (
            <p className="assistant-header-sub">{subtitle || copy.settingsTab}</p>
          ) : (
            <div className={`assistant-header-status ${status.tone}`}>
              <StatusDot
                tone={headerDotTone(status.tone, runtime?.availability)}
                pulse={status.tone === "working"}
                className="assistant-header-dot"
                label={dotOnly ? status.label : undefined}
                title={dotOnly ? status.label : undefined}
              />
              {!dotOnly && <span className="assistant-header-label">{status.label}</span>}
              {statusExtra ? (
                <>
                  {!dotOnly && <span aria-hidden="true">·</span>}
                  {statusExtra}
                </>
              ) : (
                (!settings || actions) &&
                detail && <span className="assistant-header-detail">· {detail}</span>
              )}
            </div>
          )}
        </div>
        {!settings && assistant.browserRunning && (
          <BrowserPreview assistant={assistant} navigate={navigate} />
        )}
        {browserEntry && !pane && (
          <RouteLink
            className="assistant-header-settings agent-chat-browser"
            route={browserRoute(assistant.id)}
            navigate={navigate}
            aria-label={browserLabel}
            title={browserLabel}
          >
            <Icon name="globe" />
            <span>{assistantBrowserCopy.entry}</span>
          </RouteLink>
        )}
        {actions}
        {!settings && !pane && (
          <button
            type="button"
            className="assistant-header-settings"
            aria-label={copy.settings}
            onClick={openSettings}
          >
            <Icon name="settings" />
            <span>{copy.settingsTab}</span>
          </button>
        )}
        {pane && (
          <>
            <button
              type="button"
              className="assistant-header-icon"
              aria-label={viewsCopy.paneMenu(assistant.name)}
              aria-haspopup="menu"
              aria-expanded={menu.open}
              onClick={menu.toggle}
            >
              <Icon name="more" />
            </button>
            <RowMenu
              label={viewsCopy.paneMenu(assistant.name)}
              state={menu}
              items={[
                ...pane.menuItems,
                ...(browserEntry
                  ? [
                      {
                        id: "browser",
                        label: browserLabel,
                        run: () => navigate(browserRoute(assistant.id)),
                      },
                    ]
                  : []),
                { id: "settings", label: copy.settingsTab, run: openSettings },
              ]}
            />
            <button
              type="button"
              className="assistant-header-icon"
              aria-label={viewsCopy.removePane(assistant.name)}
              title={viewsCopy.removePane(assistant.name)}
              onClick={pane.close}
            >
              <Icon name="close" />
            </button>
          </>
        )}
      </header>
      {missing && (
        <p role="status" className="assistant-notice">
          {copy.connectionMissingHint}
        </p>
      )}
    </>
  );
}
