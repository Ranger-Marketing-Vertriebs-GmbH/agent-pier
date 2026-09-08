import LogoutButton from "../features/login/LogoutButton.jsx";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { memoryCopy } from "../lib/i18n/messages/memory.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";
import React from "react";
import Icon from "../components/Icon.jsx";
import ProviderMark from "../components/ProviderMark.jsx";
import { names } from "../lib/providers.js";
import SidebarGroup, { sessionActivity } from "./SidebarGroup.jsx";
export default function Sidebar({
  mobileNav,
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
  return (
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
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
        <SidebarGroup
          name="management"
          label={commonCopy.management}
          activeKey={view !== "workspace" && view !== "missing" ? view : ""}
        >
          <button
            aria-label={commonCopy.accounts}
            className={view === "accounts" ? "nav-item selected" : "nav-item"}
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
            className={view === "repositories" ? "nav-item selected" : "nav-item"}
            onClick={() => page("repositories")}
          >
            <Icon name="folder" />
            {copy.repositoriesNavigation}
          </button>
          <button
            className={view === "extensions" ? "nav-item selected" : "nav-item"}
            onClick={() => page("extensions")}
          >
            <Icon name="grid" />
            {copy.extensionsNavigation}
          </button>
          <button
            className={view === "plugins" ? "nav-item selected" : "nav-item"}
            onClick={() => page("plugins")}
          >
            <Icon name="grid" />
            {copy.pluginsNavigation}
          </button>
          <button
            className={view === "agentbus" ? "nav-item selected" : "nav-item"}
            onClick={() => page("agentbus")}
          >
            <Icon name="link" />
            {copy.agentBusNavigation}
          </button>
          <button
            className={view === "pipelines" ? "nav-item selected" : "nav-item"}
            onClick={() => page("pipelines")}
          >
            <Icon name="grid" />
            {pipelineCopy.title}
          </button>
          <button
            className={view === "memory" ? "nav-item selected" : "nav-item"}
            onClick={() => page("memory")}
          >
            <Icon name="grid" />
            {memoryCopy.title}
          </button>
          <button
            className={view === "settings" ? "nav-item selected" : "nav-item"}
            onClick={() => page("settings")}
          >
            <Icon name="folder" />
            {commonCopy.settings}
          </button>
        </SidebarGroup>
      </nav>
      <SidebarGroup
        name="sessions"
        label={commonCopy.sessions}
        count={state.sessions.length.toString().padStart(2, "0")}
        defaultOpen
        activeKey={selected}
      >
        <div className="session-list">
          {state.sessions.length ? (
            state.sessions.map((s) => {
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
        {state.remoteUrl && (
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
