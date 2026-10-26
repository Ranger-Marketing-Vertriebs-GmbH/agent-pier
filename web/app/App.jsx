import AssistantsGate from "../features/assistants/AssistantsGate.jsx";
import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { FileEditorProvider } from "../features/files/file-editor-context.jsx";
import useLanguage from "../lib/i18n/useLanguage.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { appCopy as copy, sidebarCopy } from "../lib/i18n/messages/app.js";
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import ErrorMessage from "../components/ErrorMessage.jsx";
import Icon from "../components/Icon.jsx";
import Sidebar from "./Sidebar.jsx";
import AppDialogs from "./AppDialogs.jsx";
import AppSearch from "./AppSearch.jsx";
import SavePrompt from "../components/SavePrompt.jsx";
import { defaultSessionMode, screenRoute } from "./routes.js";
import { CrossLinkOrigin } from "./cross-link.js";
import DashboardPage from "../features/dashboard/DashboardPage.jsx";
import useWorkspaceState from "./useWorkspaceState.js";
import useWorkspaceNavigation from "./useWorkspaceNavigation.js";
import SidebarNewMenu from "./SidebarNewMenu.jsx";
import useNewMenuItems from "./useNewMenuItems.js";
import MobileHeader from "./MobileHeader.jsx";
import useFileNavigationGuard from "../features/files/useFileNavigationGuard.js";
import FileNavigationGuardDialog from "../features/files/FileNavigationGuardDialog.jsx";
import AgentsOff from "../features/assistants/AgentsOff.jsx";
import { publishInboxSummary } from "../features/inbox/inbox-store.js";
import {
  useAppBadge,
  usePushPresence,
} from "../features/notifications/usePushPresence.js";
const AgentsPage = lazy(() => import("../features/assistants/AgentsPage.jsx"));
const ProjectsPage = lazy(() => import("../features/projects/ProjectsPage.jsx"));
const CodingPage = lazy(() => import("../features/coding/CodingPage.jsx"));
const Settings = lazy(() => import("../features/settings/SettingsPage.jsx"));
const ConnectionsPage = lazy(() => import("../features/connections/ConnectionsPage.jsx"));
const SessionWorkspace = lazy(() => import("../features/sessions/SessionWorkspace.jsx"));
const PipelinePage = lazy(() => import("../features/pipelines/PipelinePage.jsx"));
const ArtifactsPage = lazy(() => import("../features/artifacts/ArtifactsPage.jsx"));
const FilesPage = lazy(() => import("../features/files/FilesPage.jsx"));
const InboxPage = lazy(() => import("../features/inbox/InboxPage.jsx"));
export default function App() {
  const { enabled } = useAssistantFeature();
  return (
    <FileEditorProvider>
      <AssistantsGate enabled={enabled}>
        <Application />
      </AssistantsGate>
    </FileEditorProvider>
  );
}
function Application() {
  const { enabled: agentsEnabled, loading: agentsLoading } = useAssistantFeature();
  useLanguage();
  const { state, loading, error, ready, refresh } = useWorkspaceState();
  // The polled state carries the inbox count for the sidebar and the phone header.
  useEffect(() => {
    publishInboxSummary(state.inbox);
  }, [state.inbox]);
  // Quiet while visible, and the inbox count on the installed app's badge.
  usePushPresence(state.pushDevices > 0);
  useAppBadge();
  const [modal, setModal] = useState(null),
    [mobileNav, setMobileNav] = useState(false),
    [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const expandButton = useRef(null),
    collapseButton = useRef(null),
    restoreFocus = useRef(false),
    navOpener = useRef(null);
  // The activated toggle is unmounted by the transition, so its replacement takes the focus.
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (sidebarCollapsed ? expandButton : collapseButton).current?.focus();
  }, [sidebarCollapsed]);
  useEffect(() => {
    // Backdrop, navigation and Escape all close the drawer; none may leave a stale opener.
    if (!mobileNav) {
      navOpener.current = null;
      return;
    }
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      setMobileNav(false);
      const opener = navOpener.current;
      navOpener.current = null;
      if (opener?.isConnected) queueMicrotask(() => opener.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNav]);
  const toggleSidebar = (collapsed) => {
    restoreFocus.current = true;
    setSidebarCollapsed(collapsed);
  };
  // In-page menu buttons (agent chat, session chat) get the focus back on Escape.
  // The clicked button itself: Safari on macOS does not focus a button on click.
  const openNavigation = useCallback((event) => {
    navOpener.current =
      event?.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : document.activeElement;
    setMobileNav(true);
  }, []);
  const fileNavigationGuard = useFileNavigationGuard();
  const {
    route: address,
    selected,
    navigate,
    select,
    activeSession,
    page,
    missing,
    extensionProfileId,
  } = useWorkspaceNavigation({
    state,
    ready,
    setMobileNav,
    setModal,
  });
  // The page that shows the address: new areas render today's pages until they have
  // their own (route-screens.js); cross-links keep the address as their origin.
  const route = screenRoute(address);
  const view = route.view;
  const extensionsShown = view === "coding" && route.codingTab === "extensions";
  const created = async (session) => {
    await refresh();
    setModal(null);
    select(session);
  };
  const close = () => setModal(null);
  // The dialog opens over a closed drawer, as navigating from the drawer closes it.
  const launch = (tool) => {
    setMobileNav(false);
    setModal({
      type: "launch",
      tool,
    });
  };
  const update = (tool) => setModal({ type: "update", tool });
  const newItems = useNewMenuItems({ launch, navigate });
  const availableTools = [...state.tools, ...(state.utilities || [])];
  const installed = state.tools.filter((t) => t.installed).length;
  const installedToolCount = availableTools.filter((t) => t.installed).length;
  const act = (type, item) =>
    setModal({
      type,
      item,
    });
  return (
    <AppSearch
      navigate={navigate}
      launch={launch}
      extensionProfileId={extensionProfileId}
      providerConnections={ready ? state.providerConnections : null}
    >
      <div className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <button
          className={`nav-backdrop ${mobileNav ? "visible" : ""}`}
          aria-label={copy.appAriaLabel}
          onClick={() => setMobileNav(false)}
        />
        {sidebarCollapsed && (
          <div className="sidebar-float">
            <button
              ref={expandButton}
              className="icon-button"
              aria-label={sidebarCopy.expandSidebar}
              title={sidebarCopy.expandSidebar}
              onClick={() => toggleSidebar(false)}
            >
              <Icon name="arrow" />
            </button>
            <SidebarNewMenu items={newItems} disabled={!installed} />
          </div>
        )}
        <Sidebar
          collapse={() => toggleSidebar(true)}
          collapseRef={collapseButton}
          {...{
            mobileNav,
            select,
            launch,
            installed,
            view,
            page,
            navigate,
            route,
            address,
            ready,
            state,
            selected,
            error,
            loading,
          }}
        />
        <main>
          <MobileHeader
            {...{
              mobileNav,
              setMobileNav,
              select,
              launch,
              navigate,
              installed,
            }}
          />
          {error && (
            <div className="global-error">
              <ErrorMessage error={error} />
              <button onClick={() => refresh().catch(() => {})}>
                {commonCopy.retry}
              </button>
            </div>
          )}
          <CrossLinkOrigin.Provider value={address}>
            <Suspense
              fallback={
                <p className="loading" role="status">
                  {copy.workspaceLoading}
                </p>
              }
            >
              {missing ? (
                <div className="page">
                  <h1>{missing}</h1>
                  <p>{copy.pageDescription}</p>
                  <button className="button secondary" onClick={() => select(null)}>
                    {copy.returnToOverview}
                  </button>
                </div>
              ) : !ready && (selected || extensionsShown) ? (
                <div className="page">
                  <p className="loading" role="status">
                    {copy.workspaceLoading}
                  </p>
                </div>
              ) : view === "agents" ? (
                agentsEnabled ? (
                  <AgentsPage
                    route={route}
                    navigate={navigate}
                    subagentProfiles={
                      ready
                        ? Boolean(state.sharedCliExtensions && extensionProfileId)
                        : null
                    }
                    openNavigation={openNavigation}
                    navigationOpen={mobileNav}
                  />
                ) : agentsLoading ? (
                  <p className="loading" role="status">
                    {copy.workspaceLoading}
                  </p>
                ) : (
                  <AgentsOff
                    route={route}
                    navigate={navigate}
                    openNavigation={openNavigation}
                    navigationOpen={mobileNav}
                  />
                )
              ) : view === "pipelines" ? (
                <Suspense
                  fallback={
                    <p className="loading" role="status">
                      {copy.workspaceLoading}
                    </p>
                  }
                >
                  <PipelinePage
                    route={route}
                    onNavigate={navigate}
                    accounts={state.accounts}
                    home={state.home}
                    onLaunchProfile={(profile) => setModal({ type: "launch", profile })}
                  />
                </Suspense>
              ) : view === "artifacts" ? (
                <Suspense>
                  <ArtifactsPage
                    route={route}
                    onNavigate={navigate}
                    sessions={state.sessions}
                    tools={state.tools}
                    openNavigation={openNavigation}
                    navigationOpen={mobileNav}
                  />
                </Suspense>
              ) : view === "inbox" ? (
                <InboxPage
                  route={route}
                  navigate={navigate}
                  openNavigation={openNavigation}
                  navigationOpen={mobileNav}
                />
              ) : view === "files" ? (
                <Suspense
                  fallback={
                    <p className="loading" role="status">
                      {copy.workspaceLoading}
                    </p>
                  }
                >
                  <FilesPage route={route} navigate={navigate} />
                </Suspense>
              ) : view === "settings" ? (
                <Settings
                  state={state}
                  refresh={refresh}
                  ready={ready}
                  route={route}
                  onNavigate={navigate}
                  openNavigation={openNavigation}
                  navigationOpen={mobileNav}
                />
              ) : view === "coding" ? (
                <CodingPage
                  {...{
                    route,
                    state,
                    ready,
                    refresh,
                    act,
                    launch,
                    page,
                    setModal,
                    availableTools,
                    loading,
                    onNavigate: navigate,
                    openNavigation,
                    navigationOpen: mobileNav,
                  }}
                  profileId={route.profileId || ""}
                />
              ) : view === "projects" ? (
                <ProjectsPage
                  route={route}
                  onNavigate={navigate}
                  openNavigation={openNavigation}
                  navigationOpen={mobileNav}
                  home={state.home}
                  defaultCwd={state.defaultCwd}
                  state={state}
                  select={select}
                  onLaunch={(cwd) =>
                    setModal({
                      type: "launch",
                      cwd,
                    })
                  }
                />
              ) : view === "connections" ? (
                <ConnectionsPage
                  {...{
                    refresh,
                    state,
                    ready,
                    act,
                    route,
                    onNavigate: navigate,
                    openNavigation,
                    navigationOpen: mobileNav,
                  }}
                />
              ) : activeSession ? (
                <SessionWorkspace
                  openNavigation={openNavigation}
                  key={activeSession.id}
                  session={activeSession}
                  route={route}
                  navigate={navigate}
                  account={state.accounts.find((a) => a.id === activeSession.accountId)}
                  autoResume={state.autoResumeInterrupted !== false}
                  action={act}
                  mode={
                    activeSession.tool === "shell" && route.mode !== "files"
                      ? "terminal"
                      : route.mode ||
                        defaultSessionMode(
                          activeSession,
                          window.matchMedia("(max-width: 700px)").matches,
                        )
                  }
                  setMode={(mode) =>
                    navigate({
                      ...route,
                      mode,
                    })
                  }
                />
              ) : (
                <DashboardPage
                  {...{
                    state,
                    installedToolCount,
                    availableTools,
                    installed,
                    error,
                    loading,
                    launch,
                    page,
                    setModal,
                  }}
                />
              )}
            </Suspense>
          </CrossLinkOrigin.Provider>
        </main>
        {/* A share sheet that needs one more tap in a home-screen app (FileLink). */}
        <SavePrompt />
        <AppDialogs
          {...{
            modal,
            state,
            close,
            created,
            refresh,
            launch,
            update,
            page,
            select,
          }}
        />
        <FileNavigationGuardDialog guard={fileNavigationGuard} />
      </div>
    </AppSearch>
  );
}
