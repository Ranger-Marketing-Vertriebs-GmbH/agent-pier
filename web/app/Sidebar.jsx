import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";
import React, { lazy, Suspense } from "react";
import Icon from "../components/Icon.jsx";
import { names } from "../lib/providers.js";
const AssistantSidebar = lazy(
  () => import("../features/assistants/AssistantSidebar.jsx"),
);
import useMobileLayout from "../lib/useMobileLayout.js";
import SidebarMenu from "./SidebarMenu.jsx";
import SidebarGroup from "./SidebarGroup.jsx";
import SessionRow from "./SessionRow.jsx";
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
  // Off-canvas on phones: keep the closed drawer out of the tab order.
  const mobile = useMobileLayout();
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
    <aside className={`sidebar ${mobileNav ? "open" : ""}`} inert={mobile && !mobileNav}>
      <div className="sidebar-head">
        <button
          ref={collapseRef}
          className="icon-button sidebar-collapse"
          aria-label={copy.collapseSidebar}
          title={copy.collapseSidebar}
          onClick={collapse}
        >
          <Icon name="back" />
        </button>
        <button
          className="brand"
          onClick={() => select(null)}
          aria-label={copy.brandAriaLabel}
        >
          <span className="brand-symbol">
            <Icon name="terminal" size={mobile ? 18 : 22} />
          </span>
          <span>
            {copy.brandLabel}
            <span className="brand-dot">.</span>
          </span>
          <span className="local-badge">{copy.localBadge}</span>
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
      <div className="sidebar-launch">
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
      </div>
      <div className="sidebar-scroll">
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
              sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={selected === s.id && view === "workspace"}
                  onSelect={select}
                  names={names}
                />
              ))
            ) : (
              <div className="sidebar-empty">
                <Icon name="terminal" size={20} />
                <p>{copy.sidebarEmptyDescription}</p>
                <span>{copy.sidebarEmptyLabel}</span>
              </div>
            )}
          </div>
        </SidebarGroup>
      </div>
    </aside>
  );
}
