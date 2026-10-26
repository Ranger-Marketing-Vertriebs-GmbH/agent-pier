import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";
import React, { lazy, Suspense } from "react";
import Icon from "../components/Icon.jsx";
import { isPlainClick } from "../components/link-click.js";
import { names } from "../lib/providers.js";
const AssistantSidebar = lazy(
  () => import("../features/assistants/AssistantSidebar.jsx"),
);
import useMobileLayout from "../lib/useMobileLayout.js";
import SidebarMenu from "./SidebarMenu.jsx";
import SidebarGroup, { SidebarGroupActions } from "./SidebarGroup.jsx";
import useSearchDialog from "./search-dialog.js";
import { routePath } from "./routes.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { agentsHubRoute } from "../features/assistants/hub-routes.js";
import { codingRoute } from "../features/coding/routes.js";
import SessionRow from "./SessionRow.jsx";
import InboxEntry from "../features/inbox/InboxEntry.jsx";
import LegacyTmuxNotice from "../features/dashboard/LegacyTmuxNotice.jsx";
// A link-styled icon button of a group head that navigates in-app.
function HeadLink({ icon, label, route, navigate }) {
  return (
    <a
      className="icon-button"
      href={routePath(route)}
      aria-label={label}
      title={label}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      <Icon name={icon} size={16} />
    </a>
  );
}

export default function Sidebar({
  mobileNav,
  navigate,
  route,
  address,
  ready,
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
  const search = useSearchDialog();
  // Head icons of the Agenten group (rendered by AssistantSidebar while agents are on)
  // and of the Sessions group (handoff §5.1). Their "+" buttons are how the expanded
  // sidebar creates sessions and agents; the compact "+ New" menu is only for the
  // phone header and the collapsed sidebar.
  const groupActions = {
    "assistant-chats": (
      <>
        <HeadLink
          icon="grid"
          label={copy.manageAgents}
          route={agentsHubRoute()}
          navigate={navigate}
        />
        <HeadLink
          icon="plus"
          label={assistantCopy.create}
          route={{ view: "agents", creating: true }}
          navigate={navigate}
        />
      </>
    ),
  };
  const sessionActions = (
    <>
      <HeadLink
        icon="terminal"
        label={copy.clisAndExtensions}
        route={codingRoute()}
        navigate={navigate}
      />
      <button
        type="button"
        className="icon-button"
        aria-label={commonCopy.newSession}
        title={commonCopy.newSession}
        disabled={!installed}
        onClick={() => launch()}
      >
        <Icon name="plus" size={16} />
      </button>
    </>
  );
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
          type="button"
          className="icon-button sidebar-search"
          aria-label={copy.search}
          title={copy.search}
          onClick={() => search.open()}
        >
          <Icon name="search" size={16} />
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
            address,
            selected,
            page,
            navigate,
            select,
            state,
            ready,
            localAccess,
            error,
            loading,
            mobileNav,
          }}
        />
      </div>
      <div className="sidebar-inbox">
        <InboxEntry
          active={view === "inbox"}
          onOpen={() => navigate({ view: "inbox" })}
        />
      </div>
      <div className="sidebar-scroll">
        {agentsEnabled && (
          <SidebarGroupActions.Provider value={groupActions}>
            <Suspense fallback={null}>
              <AssistantSidebar navigate={navigate} route={route} />
            </Suspense>
          </SidebarGroupActions.Provider>
        )}
        <SidebarGroup
          name="sessions"
          label={commonCopy.sessions}
          count={String(sessions.length)}
          defaultOpen
          activeKey={selected}
          actions={sessionActions}
        >
          <LegacyTmuxNotice status={state.legacyTmux} className="sidebar-legacy-tmux" />
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
