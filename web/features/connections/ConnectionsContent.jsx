import React, { Suspense, useEffect } from "react";
import AccountsHub from "../accounts/AccountsHub.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { detailComponents } from "../accounts/account-details.js";
import { usageEntry } from "../accounts/account-usage-view.js";
import { GithubCategory, SecretsCategory } from "./CredentialCategories.jsx";
import McpCategory from "./McpCategory.jsx";
import McpUsedBy from "./McpUsedBy.jsx";
import SshCategory from "./SshCategory.jsx";
import SshFullView from "./SshFullView.jsx";
import { connectionsRoute } from "./routes.js";

const loadingLine = (
  <p className="loading" role="status">
    {copy.loading}
  </p>
);

/** An Accounts-type entry (model access, services, MCP server): its detail component. */
function AccountEntry({ entry, shared, usedBy }) {
  const { data, accountUsage, navigate } = shared;
  const Detail = detailComponents[entry.kind];
  if (entry.kind === "loading") return loadingLine;
  if (entry.kind === "error")
    return (
      <div className="accounts-detail-error">
        <ErrorMessage error={entry.record.error} />
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            (entry.record.source === "chatgpt"
              ? data.reloadChatgpt()
              : data.reloadMcp()
            ).catch(() => {})
          }
        >
          {commonCopy.retry}
        </button>
      </div>
    );
  if (!Detail) return null;
  return (
    <Suspense fallback={loadingLine}>
      <Detail
        key={`${entry.section}:${entry.item}`}
        entry={entry}
        usage={usageEntry(accountUsage, entry.kind, entry.item)}
        agentsEnabled={shared.agentsEnabled}
        state={shared.state}
        data={data}
        refresh={shared.refresh}
        navigate={navigate}
        act={shared.act}
        oauth={shared.oauth}
        mcpNotice={shared.mcpNotice}
        notifyMcp={shared.notifyMcp}
        usedBy={usedBy}
      />
    </Suspense>
  );
}

/** Model access and services: the entry list beside the open entry, as on Accounts. */
function AccountsArea({ section, entry, shared, narrow }) {
  const open = Boolean(entry);
  const hub = (
    <AccountsHub
      state={shared.state}
      data={shared.data}
      usage={shared.accountUsage}
      agentsEnabled={shared.agentsEnabled}
      selected={entry}
      navigate={shared.navigate}
      groups={[section]}
    />
  );
  const pane = (
    <div className="accounts-pane">
      {entry ? (
        <AccountEntry entry={entry} shared={shared} />
      ) : (
        <p className="accounts-empty">{copy.selectHint}</p>
      )}
    </div>
  );
  if (narrow) return open ? pane : hub;
  return (
    <div className={["accounts-layout", open ? "has-detail" : ""].join(" ").trim()}>
      {hub}
      {pane}
    </div>
  );
}

function SshItem({ shared, item }) {
  const { catalog, navigate } = shared;
  const access = catalog.accesses.find((entry) => entry.id === item);
  const missing = catalog.accessesLoaded && !access;
  useEffect(() => {
    if (missing) navigate(connectionsRoute("ssh"), true);
  }, [missing, navigate]);
  if (!access) return loadingLine;
  return (
    <SshFullView
      access={access}
      catalog={catalog}
      usage={
        shared.connectionUsage
          ? (shared.connectionUsage.ssh?.[access.id] ?? null)
          : undefined
      }
      agentsEnabled={shared.agentsEnabled}
      assistants={shared.assistants}
      navigate={navigate}
      reloadUsage={shared.reloadAll}
      onDeleted={(id) => {
        catalog.setAccesses((current) => ({
          accesses: (current?.accesses || []).filter((entry) => entry.id !== id),
        }));
        shared.reloadAll();
        navigate(connectionsRoute("ssh"), true);
      }}
    />
  );
}

/** The content of one category: its list, an entry beside it, or a full view. */
export default function ConnectionsContent({ section, route, entry, shared, narrow }) {
  if (section === "models" || section === "services")
    return (
      <AccountsArea section={section} entry={entry} shared={shared} narrow={narrow} />
    );
  if (section === "mcp-servers") {
    if (entry) {
      const server = entry.kind === "mcp-server" ? entry.record : null;
      return (
        <div className="connections-mcp-full">
          <AccountEntry
            entry={entry}
            shared={shared}
            usedBy={
              server && (
                <McpUsedBy
                  server={server}
                  usage={usageEntry(shared.accountUsage, "mcp-server", server.id)}
                  agentsEnabled={shared.agentsEnabled}
                  assistants={shared.assistants}
                  navigate={shared.navigate}
                  onChanged={() => {
                    shared.reloadAll();
                    shared.data.reloadMcp();
                  }}
                />
              )
            }
          />
        </div>
      );
    }
    return (
      <McpCategory
        data={shared.data}
        accountUsage={shared.accountUsage}
        connectionUsage={shared.connectionUsage}
        problems={shared.problems}
        reloadUsage={shared.reloadAll}
        agentsEnabled={shared.agentsEnabled}
        assistants={shared.assistants}
        navigate={shared.navigate}
        narrow={narrow}
        oauth={shared.oauth}
        oauthResult={route.mcpOAuth}
        mcpNotice={shared.mcpNotice}
        list={shared.lists.mcp}
        activeId={shared.active.mcp}
        setActiveId={(id) => shared.setActive((current) => ({ ...current, mcp: id }))}
      />
    );
  }
  if (section === "ssh")
    return route.item ? (
      <SshItem shared={shared} item={route.item} />
    ) : (
      <SshCategory
        catalog={shared.catalog}
        connectionUsage={shared.connectionUsage}
        reloadUsage={shared.reloadAll}
        agentsEnabled={shared.agentsEnabled}
        assistants={shared.assistants}
        navigate={shared.navigate}
        narrow={narrow}
        list={shared.lists.ssh}
        activeId={shared.active.ssh}
        setActiveId={(id) => shared.setActive((current) => ({ ...current, ssh: id }))}
      />
    );
  if (section === "secrets")
    return <SecretsCategory shared={shared} loading={loadingLine} />;
  if (section === "github")
    return <GithubCategory shared={shared} item={route.item} loading={loadingLine} />;
  return null;
}
