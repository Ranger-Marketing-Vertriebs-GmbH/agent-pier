import { commonCopy } from "../../lib/i18n/messages/common.js";
import { dashboardPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import React from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
export default function DashboardPage({
  state,
  installedToolCount,
  availableTools,
  installed,
  error,
  loading,
  launch,
  page,
  setModal,
}) {
  return (
    <div className="page dashboard">
      <div className="page-topline">
        <span>{copy.pageToplineLabel}</span>
        <span className="subtle">
          <span className="status-dot running" />
          {installedToolCount}
          {copy.subtle}
        </span>
      </div>
      <section className="hero">
        <div className="eyebrow">
          <span className="tiny-terminal">›_</span>
          {copy.eyebrow}
        </div>
        <h1>
          {copy.heroTitle}
          <br />
          <span>{copy.heroLabel}</span>
        </h1>
        <p>
          {copy.supportedTools}
          <br />
          {copy.workspaceDescription}
        </p>
        <button
          className="button primary hero-cta"
          onClick={() => launch()}
          disabled={!installed}
        >
          <Icon name="plus" />
          {copy.startNewSession}
          <Icon name="arrow" size={17} />
        </button>
        <div className="workspace-snapshot">
          <div className="snapshot-heading">
            <Icon name="terminal" size={16} />
            <span>{copy.snapshotHeadingLabel}</span>
          </div>
          <div>
            <span>{commonCopy.availableTools}</span>
            <strong>
              {installedToolCount}
              <small> / {availableTools.length}</small>
            </strong>
          </div>
          <div>
            <span>{commonCopy.activeSessions}</span>
            <strong>
              {state.sessions
                .filter((s) => s.status === "running")
                .length.toString()
                .padStart(2, "0")}
            </strong>
          </div>
          <div>
            <span>{commonCopy.availableProfiles}</span>
            <strong>
              {state.accounts
                .filter((a) => a.tool !== "shell")
                .length.toString()
                .padStart(2, "0")}
            </strong>
          </div>
          <p>
            <span className="status-dot running" />
            {error ? commonCopy.serviceUnavailable : copy.workspaceSnapshotDescription}
          </p>
        </div>
      </section>
      <section className="tools-section">
        <div className="section-heading">
          <h2>{copy.sectionHeadingHeading}</h2>
          <span>{copy.sectionHeadingLabel}</span>
        </div>
        <div className="tool-grid">
          {availableTools.map((t) => (
            <article
              className={`tool-card ${!t.installed ? "unavailable" : ""}`}
              key={t.id}
            >
              <div className="tool-card-top">
                <ProviderMark tool={t.id} />
                <span className={`tool-state ${t.installed ? "available" : ""}`}>
                  <i />
                  {t.installed ? commonCopy.ready : commonCopy.notInstalled}
                </span>
              </div>
              <h3>{t.name}</h3>
              <p>
                {
                  {
                    codex: copy.toolGridCodex,
                    claude: copy.toolGridClaude,
                    opencode: copy.toolGridOpencode,
                    shell: copy.toolGridShell,
                    gh: copy.toolGridGh,
                  }[t.id]
                }
              </p>
              <button
                disabled={t.id === "shell" && !t.installed}
                className={!t.installed ? "tool-install-button" : undefined}
                onClick={() =>
                  t.installed
                    ? t.utility
                      ? page("repositories")
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
            </article>
          ))}
        </div>
        {loading && <p className="loading">{copy.workspaceLoading}</p>}
      </section>
      <div className="dashboard-note">
        <Icon name="terminal" size={18} />
        <p>
          <strong>{copy.dashboardNoteLabel}</strong>
          {copy.dashboardNoteDescription}
        </p>
      </div>
      <footer className="dashboard-footer">
        <span>{copy.localExecution}</span>
        <span>
          <Icon name="shield" size={13} />
          {copy.privateAccess}
        </span>
      </footer>
    </div>
  );
}
