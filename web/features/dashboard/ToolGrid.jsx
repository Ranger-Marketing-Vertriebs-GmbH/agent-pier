import React from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { dashboardPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { toolInstallerCopy } from "../../lib/i18n/messages/tools.js";
import { utilityPages } from "../../lib/providers.js";

const outdated = (tool) => tool.versionStatus === "update-required";

/**
 * The coding CLIs and utilities with install, start, update and remove actions. Shown
 * on the dashboard and on Coding › CLIs & Erweiterungen › Installation.
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
          <p>
            {
              {
                codex: copy.toolGridCodex,
                claude: copy.toolGridClaude,
                opencode: copy.toolGridOpencode,
                shell: copy.toolGridShell,
                gh: copy.toolGridGh,
                nono: copy.toolGridNono,
                chromium: copy.toolGridChromium,
              }[t.id]
            }
          </p>
          {/* A utility with nothing to configure in AgentPier keeps its install
              button, but offers no follow-up action once it is installed. */}
          {(!t.installed || !t.utility || utilityPages[t.id]) && (
            <button
              disabled={t.id === "shell" && !t.installed}
              className={!t.installed ? "tool-install-button" : undefined}
              onClick={() =>
                t.installed
                  ? t.utility
                    ? page(utilityPages[t.id])
                    : launch(t.id)
                  : setModal({
                      type: "install",
                      tool: t.id,
                    })
              }
            >
              {t.installed
                ? t.utility
                  ? copy.githubCredentials
                  : commonCopy.startSession
                : t.id === "shell"
                  ? copy.shellUnavailable
                  : commonCopy.installCli}
              <Icon name="arrow" size={16} />
            </button>
          )}
          {t.installed &&
            (["codex", "claude", "opencode", "nono"].includes(t.id) ||
              (t.id === "chromium" && t.updateAvailable)) && (
              <button
                className={`tool-update-button${outdated(t) ? " update-required" : ""}`}
                onClick={() => setModal({ type: "update", tool: t.id })}
              >
                {t.id === "chromium"
                  ? toolInstallerCopy.updateBrowser
                  : toolInstallerCopy.updateCli}
                <Icon name="refresh" size={16} />
              </button>
            )}
          {t.installed && t.id === "chromium" && (
            <button
              className="tool-remove-button"
              onClick={() =>
                setModal({ type: "removeTool", item: { tool: t.id, name: t.name } })
              }
            >
              {copy.removeTool}
              <Icon name="trash" size={16} />
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
