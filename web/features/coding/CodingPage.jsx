import React, { lazy, Suspense } from "react";
import { codingPageCopy as copy } from "../../lib/i18n/messages/coding.js";
import { dashboardPageCopy } from "../../lib/i18n/messages/dashboard.js";
import ToolGrid from "../dashboard/ToolGrid.jsx";
import CodingFrame from "./CodingFrame.jsx";
import McpTab from "./McpTab.jsx";
import { codingRoute } from "./routes.js";

const CliAccountsTab = lazy(() => import("./accounts/CliAccountsTab.jsx"));
const ExtensionsPage = lazy(() => import("../extensions/ExtensionsPage.jsx"));

/**
 * Coding › CLIs & Erweiterungen (/coding/clis): Installation (the dashboard's CLI
 * grid), native CLI accounts, the CLI profiles' extensions and AgentPier as an MCP
 * server for the CLIs. Each tab draws the shared frame (CodingFrame) itself, so a
 * tab can turn it into a subpage or add a subtitle.
 */
export default function CodingPage({
  route,
  state,
  ready,
  refresh,
  act,
  onNavigate,
  openNavigation,
  navigationOpen = false,
  availableTools,
  loading,
  launch,
  page,
  setModal,
  profileId,
}) {
  const tab = route.codingTab;
  const installed = availableTools.filter((tool) => tool.installed).length;
  const frame = {
    tab,
    counts: { install: ready ? installed : undefined },
    onTab: (next) =>
      next !== tab &&
      onNavigate(
        next === "extensions"
          ? codingRoute("extensions", { profileId: profileId || "" })
          : codingRoute(next),
      ),
    onLeading: openNavigation,
    navigationOpen,
  };
  const fallback = (
    <CodingFrame {...frame}>
      <p className="loading" role="status">
        {copy.loading}
      </p>
    </CodingFrame>
  );
  if (tab === "accounts")
    return (
      <Suspense fallback={fallback}>
        <CliAccountsTab {...{ frame, state, ready, refresh, act, route, onNavigate }} />
      </Suspense>
    );
  if (tab === "mcp")
    return <McpTab frame={frame} route={route} onNavigate={onNavigate} />;
  if (tab === "extensions")
    return (
      <Suspense fallback={fallback}>
        <ExtensionsPage
          frame={frame}
          shared={state.sharedCliExtensions}
          accounts={state.accounts}
          profileId={profileId}
          extensionTab={route.extensionTab}
          install={route.install}
          onNavigate={onNavigate}
        />
      </Suspense>
    );
  return (
    <CodingFrame {...frame}>
      <p className="coding-hint">{copy.installHint}</p>
      <ToolGrid tools={availableTools} launch={launch} page={page} setModal={setModal} />
      {loading && <p className="loading">{dashboardPageCopy.workspaceLoading}</p>}
    </CodingFrame>
  );
}
