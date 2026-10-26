import React from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { mobileHeaderCopy } from "../../lib/i18n/messages/app.js";
import useAssistants from "./useAssistants.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { activityFor, headerDotTone, headerStatus } from "./assistant-status.js";
import { assistantShellCopy } from "../../lib/i18n/messages/assistant-shell.js";
import { assistantBrowserCopy } from "../../lib/i18n/messages/assistant-browser.js";
import { shellLevel } from "./shell-level.js";
import BrowserPreview from "./browser/BrowserPreview.jsx";
import "./assistant-shell.css";
import StatusDot from "../../components/StatusDot.jsx";

// One bar for the agent chat and its settings (handoff 1d, 2e, 2f). Below 701px it
// replaces the app's mobile header, so it carries the navigation button itself.
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
}) {
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
  });
  const missing = status.tone === "missing";
  const settings = variant === "settings";
  const detail = member
    ? `${member.role} · ${assistant.model.modelId}`
    : assistant.model.modelId;
  const shell = shellLevel(assistant);
  return (
    <>
      <header className={`assistant-header ${variant}`}>
        {openNavigation && (
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
            <h1>{assistant.name}</h1>
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
            <p className={`assistant-header-status ${status.tone}`}>
              <StatusDot
                tone={headerDotTone(status.tone, runtime?.availability)}
                pulse={status.tone === "working"}
                className="assistant-header-dot"
              />
              <span className="assistant-header-label">{status.label}</span>
              {(!settings || actions) && detail && (
                <span className="assistant-header-detail">· {detail}</span>
              )}
            </p>
          )}
        </div>
        {!settings && assistant.browserRunning && (
          <BrowserPreview assistant={assistant} navigate={navigate} />
        )}
        {actions}
        {!settings && (
          <button
            type="button"
            className="assistant-header-settings"
            aria-label={copy.settings}
            onClick={() =>
              navigate({ view: "agents", assistantId: assistant.id, agentSettings: true })
            }
          >
            <Icon name="settings" />
            <span>{copy.settingsTab}</span>
          </button>
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
