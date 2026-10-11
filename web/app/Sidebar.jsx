import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";
import React, { lazy, Suspense } from "react";
import Icon from "../components/Icon.jsx";
import ProviderMark from "../components/ProviderMark.jsx";
import { names } from "../lib/providers.js";
const AssistantSidebar = lazy(
  () => import("../features/assistants/AssistantSidebar.jsx"),
);
import SidebarMenu from "./SidebarMenu.jsx";
import SidebarGroup, { sessionActivity, sandboxBadge } from "./SidebarGroup.jsx";
export default function Sidebar({
  mobileNav,
  navigate,
  route,
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
  const { enabled: agentsEnabled } = useAssistantFeature();
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
        <SidebarMenu
          {...{
            view,
            selected,
            page,
            select,
            state,
            agentsEnabled,
            localAccess,
            error,
            loading,
            mobileNav,
          }}
        />
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
      {agentsEnabled && (
        <Suspense fallback={null}>
          <AssistantSidebar navigate={navigate} route={route} />
        </Suspense>
      )}
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
    </aside>
  );
}
