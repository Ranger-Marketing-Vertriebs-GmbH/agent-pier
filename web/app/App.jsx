import useLanguage from "../lib/i18n/useLanguage.js";
import MemoryPage from "../features/memory/MemoryPage.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { appCopy as copy } from "../lib/i18n/messages/app.js";
import React, { lazy, Suspense, useState } from "react";
import api from "../lib/api.js";
import ErrorMessage from "../components/ErrorMessage.jsx";
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
const PipelinePage = lazy(() => import("../features/pipelines/PipelinePage.jsx"));
const AgentBus = lazy(() => import("../features/agentbus/AgentBusPage.jsx"));
export default function App() {
  useLanguage();
  const { state, loading, error, ready, refresh } = useWorkspaceState();
  const [modal, setModal] = useState(null),
    [mobileNav, setMobileNav] = useState(false);
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
    <div className="app">
      <button
        className={`nav-backdrop ${mobileNav ? "visible" : ""}`}
        aria-label={copy.appAriaLabel}
        onClick={() => setMobileNav(false)}
      />
      <Sidebar
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
              onSession={created}
            />
          </Suspense>
        ) : view === "memory" ? (
          <MemoryPage route={route} onNavigate={navigate} home={state.home} />
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
    </div>
  );
}
