import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import LogoutButton from "../features/login/LogoutButton.jsx";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";
import React from "react";
import Icon from "../components/Icon.jsx";
import ProviderMark from "../components/ProviderMark.jsx";
import { names } from "../lib/providers.js";
import SidebarGroup, { sessionActivity, sandboxBadge } from "./SidebarGroup.jsx";
export default function Sidebar({
  mobileNav,
  collapse,
  collapseRef,
  select,
  launch,
  installed,
  view,
  page,
  state,
  selected,
  error,
  loading,
}) {
  const hostname = window.location.hostname.replace(/\.$/, "");
  const localAccess =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  const sessions = state.sessions.filter(
    (session) => !(session.pipeline?.headless && session.status === "stopped"),
  );
  return (
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
      <div className="sidebar-top">
        <button
          ref={collapseRef}
          className="icon-button sidebar-collapse"
          aria-label={copy.collapseSidebar}
          title={copy.collapseSidebar}
          onClick={collapse}
        >
          <Icon name="back" />
        </button>
      </div>
      <button
        className="brand"
        onClick={() => select(null)}
        aria-label={copy.brandAriaLabel}
      >
        <span className="brand-symbol">
          <Icon name="terminal" size={22} />
        </span>
        <span>
          {copy.brandLabel}
          <span className="brand-dot">.</span>
        </span>
        <span className="local-badge">{copy.localBadge}</span>
      </button>
      <button
        aria-label={commonCopy.newSession}
        className="button primary new-session"
        onClick={() => launch()}
        disabled={!installed}
      >
        <Icon name="plus" />
        {commonCopy.newSession}
        <span className="shortcut">↗</span>
      </button>
      <nav aria-label={copy.ariaLabel}>
        <button
          className={view === "workspace" && !selected ? "nav-item selected" : "nav-item"}
          onClick={() => select(null)}
        >
          <Icon name="grid" />
          {commonCopy.overview}
        </button>
        <button
          className={view === "artifacts" ? "nav-item selected" : "nav-item"}
          onClick={() => page("artifacts")}
        >
          <Icon name="grid" />
          {artifactCopy.title}
        </button>
        <SidebarGroup
          name="projects"
          label={commonCopy.projectsGroup}
          activeKey={["projects", "files", "pipelines"].includes(view) ? view : ""}
        >
          <button
            className={view === "projects" ? "nav-item selected" : "nav-item"}
            aria-current={view === "projects" ? "page" : undefined}
            onClick={() => page("projects")}
          >
            <Icon name="folder" />
            {copy.projectsNavigation}
          </button>
          <button
            className={view === "files" ? "nav-item selected" : "nav-item"}
            aria-current={view === "files" ? "page" : undefined}
            onClick={() => page("files")}
          >
            <Icon name="history" />
            {filesCopy.tab}
          </button>
          <button
            className={view === "pipelines" ? "nav-item selected" : "nav-item"}
            aria-current={view === "pipelines" ? "page" : undefined}
            onClick={() => page("pipelines")}
          >
            <Icon name="refresh" />
            {pipelineCopy.title}
          </button>
        </SidebarGroup>
        <SidebarGroup
          name="configuration"
          label={commonCopy.configurationGroup}
          activeKey={["accounts", "extensions", "settings"].includes(view) ? view : ""}
        >
          <button
            aria-label={commonCopy.accounts}
            className={view === "accounts" ? "nav-item selected" : "nav-item"}
            aria-current={view === "accounts" ? "page" : undefined}
            onClick={() => {
              page("accounts");
            }}
          >
            <Icon name="users" />
            {commonCopy.accounts}
            <span className="count">
              {state.accounts.filter((a) => a.tool !== "shell").length}
            </span>
          </button>
          <button
            className={view === "extensions" ? "nav-item selected" : "nav-item"}
            aria-current={view === "extensions" ? "page" : undefined}
            onClick={() => page("extensions")}
          >
            <Icon name="grid" />
            {copy.extensionsNavigation}
          </button>
          <button
            className={view === "settings" ? "nav-item selected" : "nav-item"}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => page("settings")}
          >
            <Icon name="settings" />
            {commonCopy.settings}
          </button>
        </SidebarGroup>
      </nav>
      <SidebarGroup
        name="sessions"
        label={commonCopy.sessions}
        count={sessions.length.toString().padStart(2, "0")}
        defaultOpen
        activeKey={selected}
      >
        <div className="session-list">
          {sessions.length ? (
            sessions.map((s) => {
              const activity = sessionActivity(s);
              return (
                <button
                  key={s.id}
                  className={`session-item ${selected === s.id && view === "workspace" ? "selected" : ""}`}
                  onClick={() => select(s)}
                  title={s.cwd}
                >
                  <span className="session-provider">
                    <ProviderMark tool={s.tool} small />
                    <span
                      className={`activity-dot ${activity.state}`}
                      aria-hidden="true"
                    />
                  </span>
                  <span>
                    <strong>{s.name}</strong>
                    {s.cwd && (
                      <span className="session-directory" title={s.cwd}>
                        <Icon name="folder" size={10} />
                        <span>{s.repositoryName || s.cwd}</span>
                      </span>
                    )}
                    <small>
                      <span className={`activity-label ${activity.state}`}>
                        {activity.label}
                      </span>
                      {s.tool !== "shell" && ` · ${names[s.tool]}`}
                      {s.sandbox && ` · ${sandboxBadge(s)}`}
                    </small>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="sidebar-empty">
              <Icon name="terminal" size={20} />
              <p>{copy.sidebarEmptyDescription}</p>
              <span>{copy.sidebarEmptyLabel}</span>
            </div>
          )}
        </div>
      </SidebarGroup>
      <div className="sidebar-bottom">
        <div className="host-status">
          <span className={`status-dot ${error ? "stopped" : "running"}`} />
          <span>
            {copy.hostStatusLabel}
            <small>
              {error
                ? commonCopy.serviceUnavailable
                : loading
                  ? copy.serviceConnecting
                  : copy.localHostDescription}
            </small>
          </span>
          <Icon name="shield" size={16} />
        </div>
        {state.remoteUrl && localAccess && (
          <a
            className="remote-link"
            href={state.remoteUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="link" size={14} />
            {copy.remoteLink}
            <Icon name="arrow" size={14} />
          </a>
        )}
        <LogoutButton />
        <div className="sidebar-caption">{copy.sidebarCaption}</div>
      </div>
    </aside>
  );
}
