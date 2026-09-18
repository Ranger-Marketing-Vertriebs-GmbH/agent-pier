import { FileEditorProvider } from "../features/files/file-editor-context.jsx";
import useLanguage from "../lib/i18n/useLanguage.js";
import MemoryPage from "../features/memory/MemoryPage.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { appCopy as copy, sidebarCopy } from "../lib/i18n/messages/app.js";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import api from "../lib/api.js";
import ErrorMessage from "../components/ErrorMessage.jsx";
import Icon from "../components/Icon.jsx";
import Sidebar from "./Sidebar.jsx";
import AppDialogs from "./AppDialogs.jsx";
import { defaultSessionMode } from "./routes.js";
import Repositories from "../features/repositories/RepositoriesPage.jsx";
import Plugins from "../features/plugins/PluginsPage.jsx";
import Extensions from "../features/extensions/ExtensionsPage.jsx";
import Settings from "../features/settings/SettingsPage.jsx";
import SessionWorkspace from "../features/sessions/SessionWorkspace.jsx";
import AccountsPage from "../features/accounts/AccountsPage.jsx";
import DashboardPage from "../features/dashboard/DashboardPage.jsx";
import useWorkspaceState from "./useWorkspaceState.js";
import useWorkspaceNavigation from "./useWorkspaceNavigation.js";
import MobileHeader from "./MobileHeader.jsx";
import useFileNavigationGuard from "../features/files/useFileNavigationGuard.js";
import FileNavigationGuardDialog from "../features/files/FileNavigationGuardDialog.jsx";
const PipelinePage = lazy(() => import("../features/pipelines/PipelinePage.jsx"));
const AgentBus = lazy(() => import("../features/agentbus/AgentBusPage.jsx"));
const ArtifactsPage = lazy(() => import("../features/artifacts/ArtifactsPage.jsx"));
const FilesPage = lazy(() => import("../features/files/FilesPage.jsx"));
export default function App() {
  return (
    <FileEditorProvider>
      <Application />
    </FileEditorProvider>
  );
}
function Application() {
  useLanguage();
  const { state, loading, error, ready, refresh } = useWorkspaceState();
  const [modal, setModal] = useState(null),
    [mobileNav, setMobileNav] = useState(false),
    [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const expandButton = useRef(null),
    collapseButton = useRef(null),
    restoreFocus = useRef(false);
  // The activated toggle is unmounted by the transition, so its replacement takes the focus.
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (sidebarCollapsed ? expandButton : collapseButton).current?.focus();
  }, [sidebarCollapsed]);
  const toggleSidebar = (collapsed) => {
    restoreFocus.current = true;
    setSidebarCollapsed(collapsed);
  };
  const fileNavigationGuard = useFileNavigationGuard();
  const { route, view, selected, navigate, select, activeSession, page, missing } =
    useWorkspaceNavigation({
      state,
      ready,
      setMobileNav,
      setModal,
    });
  const created = async (session) => {
    await refresh();
    setModal(null);
    select(session);
  };
  const close = () => setModal(null);
  const launch = (tool) =>
    setModal({
      type: "launch",
      tool,
    });
  const availableTools = [...state.tools, ...(state.utilities || [])];
  const installed = state.tools.filter((t) => t.installed).length;
  const installedToolCount = availableTools.filter((t) => t.installed).length;
  const act = (type, item) =>
    setModal({
      type,
      item,
    });
  return (
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
          <button
            className="icon-button"
            aria-label={commonCopy.newSession}
            title={commonCopy.newSession}
            onClick={() => launch()}
            disabled={!installed}
          >
            <Icon name="plus" />
          </button>
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
          state,
          selected,
          error,
          loading,
        }}
      />
      <main>
        <MobileHeader
          {...{
            setMobileNav,
            select,
            launch,
            installed,
          }}
        />
        {error && (
          <div className="global-error">
            <ErrorMessage error={error} />
            <button onClick={() => refresh().catch(() => {})}>{commonCopy.retry}</button>
          </div>
        )}
        {missing ? (
          <div className="page">
            <h1>{missing}</h1>
            <p>{copy.pageDescription}</p>
            <button className="button secondary" onClick={() => select(null)}>
              {copy.returnToOverview}
            </button>
          </div>
        ) : !ready && (selected || ["extensions", "plugins"].includes(view)) ? (
          <div className="page">
            <p className="loading" role="status">
              {copy.workspaceLoading}
            </p>
          </div>
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
            <ArtifactsPage route={route} onNavigate={navigate} />
          </Suspense>
        ) : view === "memory" ? (
          <MemoryPage route={route} onNavigate={navigate} home={state.home} />
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
          />
        ) : view === "agentbus" ? (
          <Suspense fallback={<p className="loading">{copy.agentBusLoading}</p>}>
            <AgentBus
              request={api}
              tab={route.busTab || "status"}
              projectId={route.projectId || ""}
              page={route.messagePage || 1}
              onNavigate={(tab, projectId = "", replace = false, page = 1) =>
                navigate(
                  {
                    view: "agentbus",
                    busTab: tab,
                    projectId,
                    messagePage: page,
                  },
                  replace,
                )
              }
            />
          </Suspense>
        ) : view === "plugins" ? (
          <Plugins
            shared={state.sharedCliExtensions}
            accounts={state.accounts}
            request={api}
            profileId={route.profileId}
            onProfileChange={(profileId) =>
              navigate({
                view,
                profileId,
              })
            }
          />
        ) : view === "extensions" ? (
          <Extensions
            shared={state.sharedCliExtensions}
            accounts={state.accounts}
            request={api}
            profileId={route.profileId}
            onProfileChange={(profileId) =>
              navigate({
                view,
                profileId,
              })
            }
          />
        ) : view === "repositories" ? (
          <Repositories
            home={state.home}
            defaultCwd={state.defaultCwd}
            onLaunch={(cwd) =>
              setModal({
                type: "launch",
                cwd,
              })
            }
          />
        ) : view === "accounts" ? (
          <AccountsPage
            {...{
              refresh,
              state,
              setModal,
              act,
            }}
          />
        ) : activeSession ? (
          <SessionWorkspace
            openNavigation={() => setMobileNav(true)}
            key={activeSession.id}
            session={activeSession}
            route={route}
            navigate={navigate}
            account={state.accounts.find((a) => a.id === activeSession.accountId)}
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
      </main>
      <AppDialogs
        {...{
          modal,
          state,
          close,
          created,
          refresh,
          launch,
          page,
          select,
        }}
      />
      <FileNavigationGuardDialog guard={fileNavigationGuard} />
    </div>
  );
}
