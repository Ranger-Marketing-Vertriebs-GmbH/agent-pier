import React, { useCallback, useEffect, useMemo, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { names } from "../../lib/providers.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { mcpCliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpServerCopy } from "../../lib/i18n/messages/mcp-servers.js";
import { itemRoute } from "../accounts/accounts-items.js";
import { clis } from "../mcp-servers/cli-support.js";
import McpFeedback from "../mcp-servers/McpFeedback.jsx";
import { McpOAuthResultBanner } from "../mcp-servers/McpOAuthLogin.jsx";
import useDirectoryUpdates from "../mcp-servers/wizard/useDirectoryUpdates.js";
import CategorySection from "./CategorySection.jsx";
import EmptyCategory from "./EmptyCategory.jsx";
import LongList from "./LongList.jsx";
import McpBulkActions from "./McpBulkActions.jsx";
import McpDetailPane from "./McpDetailPane.jsx";
import { mcpItems, mcpSources } from "./connection-items.js";

const statuses = ["installFailed", "cliError", "loginRequired", "updateAvailable", "ok"];
const tones = {
  ok: "ok",
  loginRequired: "warning",
  updateAvailable: "warning",
  installFailed: "error",
  cliError: "error",
};

const sourceShort = (server) =>
  server.source
    ? server.source.registry === "pypi"
      ? "PyPI"
      : "npm"
    : server.transport === "stdio"
      ? copy.mcpSourceShort.command
      : server.auth === "oauth"
        ? copy.mcpSourceShort.oauth
        : copy.mcpSourceShort.headers;

/**
 * Zugänge › MCP-Server: the long list (views, filters, groups by source, bulk), the
 * OAuth result a sign-in brought back, the list's notices and the detail pane.
 */
export default function McpCategory({
  data,
  accountUsage,
  connectionUsage,
  problems,
  reloadUsage,
  agentsEnabled,
  assistants,
  navigate,
  narrow,
  oauth,
  oauthResult,
  mcpNotice,
  list,
  activeId,
  setActiveId,
}) {
  const [resultShown, setResultShown] = useState(true);
  // The bulk bar stays while its dialog is open, even when the run emptied the selection.
  const [bulkOpen, setBulkOpen] = useState(false);
  useEffect(() => setResultShown(true), [oauthResult]);
  const updates = useDirectoryUpdates(data.mcpServers);
  const items = useMemo(
    () =>
      mcpItems({
        servers: data.mcpServers,
        accountUsage,
        connectionUsage,
        problems,
        updates,
      }),
    [data.mcpServers, accountUsage, connectionUsage, problems, updates],
  );
  const groupOf = useCallback(
    (item, groupBy) =>
      groupBy === "status"
        ? {
            key: item.status,
            label: copy.mcpStatus[item.status],
            order: statuses.indexOf(item.status),
          }
        : {
            key: item.group.key,
            label: copy.mcpSources[item.group.key],
            order: mcpSources.indexOf(item.group.key),
          },
    [],
  );
  const servers = data.mcpServers || [];
  const active = servers.find((server) => server.id === activeId);
  const selected = servers.filter((server) => list.state.selected.includes(server.id));
  const agentNames = new Map();
  for (const item of items)
    for (const agent of item.usage?.agents || []) agentNames.set(agent.id, agent.name);
  const open = (item) =>
    narrow ? navigate(itemRoute("mcp-servers", item.id)) : setActiveId(item.id);
  const add = () => navigate(itemRoute("mcp-servers", "new"));
  const showFinds = () => navigate(itemRoute("mcp-servers", "cli-finds"));
  const usageOf = (id) => {
    const group = accountUsage?.mcpServers;
    return group && typeof group === "object" ? (group[id] ?? undefined) : undefined;
  };
  return (
    <CategorySection
      title={copy.sections["mcp-servers"]}
      count={data.mcpServers ? String(servers.length) : ""}
      actions={
        // An empty list offers the same actions in its empty state.
        data.mcpServers && !servers.length ? null : (
          <>
            <button
              type="button"
              className="button secondary compact"
              onClick={showFinds}
            >
              {copy.foundInClis}
            </button>
            <button type="button" className="button primary compact" onClick={add}>
              {mcpServerCopy.add}
            </button>
          </>
        )
      }
    >
      <p className="accounts-note">{mcpCliCopy.restartNote}</p>
      {oauthResult && resultShown && (
        <McpOAuthResultBanner
          result={oauthResult}
          servers={data.mcpServers}
          onDismiss={() => setResultShown(false)}
        />
      )}
      <ErrorMessage error={data.mcpError} />
      {!active && <McpFeedback oauth={oauth} notice={mcpNotice} />}
      {!data.mcpServers && !data.mcpError && <p role="status">{copy.loading}</p>}
      {data.mcpServers && (
        <div
          className={["connections-list-detail", active && !narrow ? "has-detail" : ""]
            .join(" ")
            .trim()}
        >
          <LongList
            label={copy.sections["mcp-servers"]}
            items={items}
            state={list.state}
            dispatch={list.dispatch}
            groupOf={groupOf}
            searchPlaceholder={copy.searchMcp}
            filters={[
              {
                key: "transport",
                label: copy.filters.transport,
                options: ["http", "sse", "stdio"]
                  .filter((value) => servers.some((server) => server.transport === value))
                  .map((value) => ({ value, label: mcpServerCopy.transports[value] })),
              },
              {
                key: "cli",
                label: copy.filters.cli,
                options: clis.map((value) => ({ value, label: names[value] })),
              },
              {
                key: "agent",
                label: copy.filters.mcpAgent,
                options: [...agentNames].map(([value, label]) => ({ value, label })),
              },
              {
                key: "status",
                label: copy.filters.status,
                options: statuses.map((value) => ({
                  value,
                  label: copy.mcpStatus[value],
                })),
              },
            ]}
            groupOptions={["source", "status", "none"].map((value) => ({
              value,
              label: copy.groupOptions[value],
            }))}
            sortOptions={["name", "changed"].map((value) => ({
              value,
              label: copy.sortOptions[value],
            }))}
            columns={{ type: copy.columns.kind, last: copy.columns.source }}
            cells={(item) => ({
              type:
                item.kind === "stdio"
                  ? mcpServerCopy.stdioBadge
                  : (mcpServerCopy.transports[item.kind] ?? item.kind),
              usedBy: !item.usage
                ? item.record.clis?.length
                  ? item.record.clis.map((cli) => names[cli]).join(", ")
                  : copy.unknownUsage
                : item.used === false
                  ? copy.notUsed
                  : [
                      (item.record.clis || []).map((cli) => names[cli]).join(", "),
                      item.usage.agents?.length
                        ? copy.usedSummary.agents(item.usage.agents.length)
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
              status: { tone: tones[item.status], text: copy.mcpStatus[item.status] },
              last: sourceShort(item.record),
            })}
            activeId={activeId}
            onOpen={open}
            bulkOpen={bulkOpen}
            bulk={
              <McpBulkActions
                onOpenChange={setBulkOpen}
                selected={selected}
                assistants={assistants}
                data={data}
                onDone={() => {
                  data.reloadMcp();
                  reloadUsage();
                }}
              />
            }
            empty={
              <EmptyCategory
                icon="grid"
                title={copy.empty["mcp-servers"].title}
                body={copy.empty["mcp-servers"].body}
                actions={[
                  { label: copy.empty["mcp-servers"].primary, onClick: add },
                  { label: copy.empty["mcp-servers"].secondary, onClick: showFinds },
                ]}
              />
            }
          />
          {active && !narrow && (
            <McpDetailPane
              key={active.id}
              server={active}
              usage={usageOf(active.id)}
              agentsEnabled={agentsEnabled}
              assistants={assistants}
              data={data}
              oauth={oauth}
              mcpNotice={mcpNotice}
              navigate={navigate}
              reloadUsage={reloadUsage}
              close={() => setActiveId(null)}
            />
          )}
        </div>
      )}
    </CategorySection>
  );
}
