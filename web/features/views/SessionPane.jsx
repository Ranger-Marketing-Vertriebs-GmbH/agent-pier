import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { appCopy } from "../../lib/i18n/messages/app.js";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { paneTarget } from "./pane-navigation.js";
import StalePane from "./StalePane.jsx";

const SessionWorkspace = lazy(() => import("../sessions/SessionWorkspace.jsx"));

const modeOf = (tab) => (tab === "chat" ? "reader" : tab || "terminal");
const tabOf = (mode) => (mode === "reader" ? "chat" : mode);

/**
 * A session in a pane. The pane keeps its own route (tab, folder, open file), so a
 * Files pane browses without touching the address bar; the tab is saved in the view.
 */
export default function SessionPane({
  pane,
  state,
  ready,
  action,
  autoResume,
  actions,
  request,
  chrome,
}) {
  const session = state.sessions.find((item) => item.id === pane.item.id);
  const [route, setRoute] = useState(() => ({
    view: "workspace",
    sessionId: pane.item.id,
    mode: modeOf(pane.tab),
  }));
  // The saved tab wins when another tab or browser changed it.
  useEffect(() => {
    setRoute((current) =>
      tabOf(current.mode) === (pane.tab || "terminal")
        ? current
        : { view: "workspace", sessionId: pane.item.id, mode: modeOf(pane.tab) },
    );
  }, [pane.tab, pane.item.id]);
  const shell = session?.tool === "shell";
  const mode = shell && route.mode !== "files" ? "terminal" : route.mode || "terminal";
  const tab = tabOf(mode);
  const show = (next) =>
    request(next, () => {
      setRoute(next);
      const nextTab = tabOf(next.mode || "terminal");
      if (nextTab !== tab) actions.setTab(pane.key, nextTab);
    });
  const navigate = (next) => {
    const target = paneTarget(pane.item, next);
    if (target.kind === "local") return show({ ...target.route, view: "workspace" });
    if (target.kind === "rule") return actions.openRoute(target.route);
    return actions.navigate(target.route);
  };
  const menuItems = useMemo(
    () => [
      {
        id: "open-alone",
        label: viewsCopy.openAlone,
        run: () => actions.openAlone(pane.item, tab),
      },
    ],
    [actions, pane.item, tab],
  );
  if (!ready)
    return (
      <p className="loading" role="status">
        {appCopy.workspaceLoading}
      </p>
    );
  if (!session) return <StalePane reason="sessionRemoved" onRemove={chrome.close} />;
  return (
    <Suspense
      fallback={
        <p className="loading" role="status">
          {appCopy.workspaceLoading}
        </p>
      }
    >
      <SessionWorkspace
        key={session.id}
        session={session}
        account={state.accounts.find((item) => item.id === session.accountId)}
        action={action}
        autoResume={autoResume}
        mode={mode}
        setMode={(next) => show({ ...route, mode: next })}
        route={{ ...route, mode }}
        navigate={navigate}
        pane={{ ...chrome, menuItems }}
      />
    </Suspense>
  );
}
