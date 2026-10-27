import React from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { dashboardPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { toolInstallerCopy } from "../../lib/i18n/messages/tools.js";
import { toolActions, updateRequired as outdated } from "./tool-actions.js";
import { runToolAction, toolActionLabel } from "./tool-action-view.js";

const descriptions = () => ({
  codex: copy.toolGridCodex,
  claude: copy.toolGridClaude,
  opencode: copy.toolGridOpencode,
  shell: copy.toolGridShell,
  gh: copy.toolGridGh,
  nono: copy.toolGridNono,
  chromium: copy.toolGridChromium,
});

// The grid's classes and icons per action (tests and styles rely on them).
const looks = {
  install: { className: "tool-install-button", icon: "arrow" },
  unavailable: { className: "tool-install-button", icon: "arrow" },
  start: { className: undefined, icon: "arrow" },
  credentials: { className: undefined, icon: "arrow" },
  update: { className: "tool-update-button", icon: "refresh" },
  remove: { className: "tool-remove-button", icon: "trash" },
};

/**
 * The coding CLIs and utilities with every install, start, update and remove action,
 * on CLIs & extensions › Installation. The start page shows the same actions as
 * compact rows (ToolRows.jsx); both resolve them with tool-actions.js.
 */
export default function ToolGrid({ tools, launch, page, setModal }) {
  return (
    <div className="tool-grid">
      {tools.map((t) => (
        <article className={`tool-card ${!t.installed ? "unavailable" : ""}`} key={t.id}>
          <div className="tool-card-top">
            <ProviderMark tool={t.id} />
            <span
              className={`tool-state ${t.installed ? "available" : ""} ${outdated(t) ? "update-required" : ""}`}
            >
              <StatusDot tone={outdated(t) ? "warning" : t.installed ? "ok" : "idle"} />
              {outdated(t)
                ? toolInstallerCopy.updateRequiredBadge
                : t.installed
                  ? commonCopy.ready
                  : commonCopy.notInstalled}
            </span>
          </div>
          <h3>{t.name}</h3>
          {t.installed &&
            (t.minimumVersion || t.id === "chromium") &&
            t.versionStatus !== "checking" && (
              <small className="tool-version">
                {t.version
                  ? toolInstallerCopy.versionLabel(t.version)
                  : toolInstallerCopy.versionUnknown}
                {outdated(t) &&
                  ` · ${toolInstallerCopy.minimumVersion(t.minimumVersion)}`}
              </small>
            )}
          <p>{descriptions()[t.id]}</p>
          {toolActions(t).map((action) => {
            const look = looks[action.id];
            const className =
              [look.className, action.required ? "update-required" : ""]
                .filter(Boolean)
                .join(" ") || undefined;
            return (
              <button
                key={action.id}
                className={className}
                disabled={action.id === "unavailable"}
                onClick={() => runToolAction(action, t, { launch, page, setModal })}
              >
                {toolActionLabel(action)}
                <Icon name={look.icon} size={16} />
              </button>
            );
          })}
        </article>
      ))}
    </div>
  );
}
