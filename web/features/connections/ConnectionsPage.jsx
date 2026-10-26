import React, { useCallback, useEffect, useReducer, useState } from "react";
import SettingsShell from "../../components/SettingsShell.jsx";
import Icon from "../../components/Icon.jsx";
import { canonicalRoute } from "../../app/routes.js";
import useReturnTarget from "../../app/useReturnTarget.js";
import { accountsPageCopy } from "../../lib/i18n/messages/accounts.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import useAssistants from "../assistants/useAssistants.js";
import { accountItemTitle, resolveAccountItem } from "../accounts/accounts-items.js";
import useAccountUsage from "../accounts/useAccountUsage.js";
import useAccountsData from "../accounts/useAccountsData.js";
import useNarrowViewport from "../accounts/useNarrowViewport.js";
import { useMcpOAuth } from "../mcp-servers/McpOAuthLogin.jsx";
import useSshCatalog from "../ssh/useSshCatalog.js";
import ConnectionCategories from "./ConnectionCategories.jsx";
import ConnectionsContent from "./ConnectionsContent.jsx";
import { categoryCounts, visibleSections } from "./connection-categories.js";
import { initialListState, listReducer } from "./long-list.js";
import { accountConnectionSections, connectionsRoute } from "./routes.js";
import useConnectionsResource from "./useConnectionsResource.js";
import "../accounts/accounts-page.css";
import "./connections.css";

const ids = (list) => (list || []).map((item) => item.id);
// Entries that open as a full view: the long-list categories and GitHub profiles.
const fullViewSections = new Set(["ssh", "mcp-servers", "github"]);

/**
 * Zugänge (handoff 5.6): shared credentials, created once and granted where they are
 * used. Desktop shows the categories column, the category's list and the open entry;
 * phones show categories → list → entry as subpages. Entries of model access,
 * services and MCP servers keep their Accounts forms; SSH/SFTP accesses, secrets and
 * GitHub profiles their Settings forms; every entry adds "Benutzt von".
 */
export default function ConnectionsPage({
  state,
  ready = true,
  act,
  refresh,
  route,
  onNavigate,
  openNavigation,
  navigationOpen = false,
}) {
  // A cross-link's origin (`returnTo`) stays for moves inside Zugänge; on phones only
  // the page the link landed on leads back to it (AccountsPage did the same).
  const returnTo = route.returnTo;
  const returnTarget = useReturnTarget(route, onNavigate);
  const here = `${route.section}:${route.item}`;
  const [landing, setLanding] = useState({ returnTo, key: here });
  if (landing.returnTo !== returnTo) setLanding({ returnTo, key: here });
  const navigate = useCallback(
    (next, replace) => {
      const target = canonicalRoute(next);
      onNavigate(
        returnTo && target?.view === "connections" && !target.returnTo
          ? { ...target, returnTo }
          : next,
        replace,
      );
    },
    [onNavigate, returnTo],
  );
  const feature = useAssistantFeature();
  const agentsEnabled = feature.loading ? null : Boolean(feature.enabled);
  const { runtime, assistants } = useAssistants();
  const data = useAccountsData({
    agentsEnabled: agentsEnabled === true,
    runtimeReady: runtime.availability === "ready",
  });
  const [mcpNotice, setMcpNotice] = useState("");
  const oauth = useMcpOAuth({ reload: data.reloadMcp, notify: setMcpNotice });
  const catalog = useSshCatalog();
  const signature = JSON.stringify([
    agentsEnabled,
    ids(state.providerConnections),
    (data.mcpServers || []).map((server) => [server.id, server.revision]),
    ids(data.chatgpt),
    data.speech?.revision,
    data.webSearch?.revision,
    data.pdfModel?.revision,
    catalog.accesses.map((access) => [access.id, access.lastTest?.at ?? null]),
    (assistants || []).map((agent) => [agent.id, agent.revision]),
  ]);
  const accountUsage = useAccountUsage(signature);
  const usage = useConnectionsResource("/connections/usage", signature);
  const problems = useConnectionsResource("/connections/problems", signature);
  const { reload: reloadUsage } = usage;
  const { reload: reloadProblems } = problems;
  const reloadAll = useCallback(() => {
    reloadUsage();
    reloadProblems();
  }, [reloadUsage, reloadProblems]);
  const ssh = useReducer(listReducer, "project", initialListState);
  const mcp = useReducer(listReducer, "source", initialListState);
  const [active, setActive] = useState({ ssh: null, mcp: null });
  const narrow = useNarrowViewport();
  const sections = visibleSections(agentsEnabled === true);
  // An MCP sign-in result (OAuth callback) opens the MCP servers with its banner.
  const wanted = route.section || (route.mcpOAuth ? "mcp-servers" : "");
  const servicesPending = wanted === "services" && agentsEnabled === null;
  const section =
    sections.includes(wanted) || servicesPending ? wanted : narrow ? "" : "models";
  const gone = Boolean(wanted) && !servicesPending && !sections.includes(wanted);
  useEffect(() => {
    if (gone) navigate(connectionsRoute(), true);
  }, [gone, navigate]);
  const entry = accountConnectionSections.includes(section)
    ? resolveAccountItem(
        { ...route, section },
        {
          agentsEnabled,
          connections: ready ? (state.providerConnections ?? null) : null,
          accounts: ready ? state.accounts : null,
          chatgpt: data.chatgpt,
          mcpServers: data.mcpServers,
          errors: { chatgpt: data.chatgptError, mcpServers: data.mcpError },
        },
      )
    : null;
  const missing = entry?.kind === "missing";
  useEffect(() => {
    if (missing) navigate(connectionsRoute(section), true);
  }, [missing, section, navigate]);
  const counts = categoryCounts({
    problems: problems.data,
    lists: {
      connections: ready ? state.providerConnections : null,
      chatgpt: data.chatgpt,
      mcpServers: data.mcpServers,
      ssh: catalog.accessesLoaded ? catalog.accesses : null,
    },
    agentsEnabled: agentsEnabled === true,
  });
  const item = route.item && section ? route.item : "";
  const full = !narrow && Boolean(item) && fullViewSections.has(section);
  const level = !section ? "categories" : item ? "detail" : "list";
  const subpage = narrow ? level !== "categories" : full;
  const sectionLabel = copy.sections[section] || "";
  const itemTitle =
    (entry && accountItemTitle(entry)) ||
    (section === "ssh" && catalog.accesses.find((access) => access.id === item)?.name) ||
    sectionLabel;
  const toOrigin =
    Boolean(returnTarget) &&
    (!narrow || (landing.returnTo === returnTo ? landing.key : here) === here);
  const up = () =>
    navigate(level === "detail" ? connectionsRoute(section) : connectionsRoute());
  const shared = {
    state,
    data,
    refresh,
    act,
    navigate,
    oauth,
    mcpNotice,
    notifyMcp: setMcpNotice,
    agentsEnabled: agentsEnabled === true,
    assistants,
    accountUsage,
    connectionUsage: usage.data,
    problems: problems.data,
    reloadAll,
    catalog,
    lists: {
      ssh: { state: ssh[0], dispatch: ssh[1] },
      mcp: { state: mcp[0], dispatch: mcp[1] },
    },
    active,
    setActive,
  };
  const local = (
    <span className="accounts-local">
      <Icon name="shield" size={12} />
      {accountsPageCopy.subtle.trim()}
    </span>
  );
  const title = !subpage
    ? copy.title
    : level === "list" && narrow
      ? sectionLabel
      : itemTitle;
  return (
    <SettingsShell
      className={["connections-page", full ? "is-full" : ""].filter(Boolean).join(" ")}
      title={title}
      subtitle={
        !subpage ? local : level === "list" ? undefined : copy.breadcrumb(sectionLabel)
      }
      description={subpage ? undefined : copy.intro}
      leading={subpage || toOrigin ? "back" : "menu"}
      leadingLabel={
        toOrigin
          ? returnTarget.label
          : subpage
            ? level === "list"
              ? copy.title
              : copy.backToList(sectionLabel)
            : undefined
      }
      onLeading={toOrigin ? returnTarget.back : subpage ? up : openNavigation}
      navigationOpen={navigationOpen}
      actions={subpage ? null : local}
    >
      <div
        className={["connections-layout", `is-${level}`, full ? "is-full" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {(narrow ? level === "categories" : !full) && (
          <ConnectionCategories
            sections={sections}
            counts={counts}
            current={section}
            navigate={navigate}
          />
        )}
        {section && (
          <div className="connections-main">
            {servicesPending ? (
              <p role="status">{copy.loading}</p>
            ) : (
              <ConnectionsContent
                section={section}
                route={{ ...route, item }}
                entry={entry}
                shared={shared}
                narrow={narrow}
              />
            )}
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
