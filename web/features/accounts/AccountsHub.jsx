import React, { useId } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { routePath } from "../../app/routes.js";
import { names } from "../../lib/providers.js";
import {
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../lib/i18n/messages/accounts.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { connectionSummary } from "../provider-connections/connection-summary.js";
import useAssistants from "../assistants/useAssistants.js";
import { authOf } from "./useAccountAuthStates.js";
import McpServersGroup from "./McpServersGroup.jsx";
import AddLabel from "./AddLabel.jsx";
import { itemRoute } from "./accounts-items.js";
import { usageEntry, usageValue } from "./account-usage-view.js";

function HubGroup({ title, hint, action, children }) {
  const id = useId();
  return (
    <section className="accounts-group" aria-labelledby={`${id}-label`}>
      <GroupLabel id={`${id}-label`} hint={hint} action={action}>
        {title}
      </GroupLabel>
      {typeof children === "function" ? children(`${id}-label`) : children}
    </section>
  );
}

function ItemRow({ section, id, selected, navigate, ...row }) {
  const route = itemRoute(section, id);
  const current = selected?.section === section && selected.item === id;
  return (
    <ListRow
      {...row}
      href={routePath(route)}
      onClick={() => navigate(route)}
      current={current}
      className={current ? "is-selected" : ""}
    />
  );
}

// A local profile appears once its CLI login is confirmed (polled every 10 s).
function NativeAccountRow({ account, auth, state, usage, selected, navigate }) {
  if (account.kind === "local" && auth !== "authenticated") return null;
  const isDefault =
    (state.defaultAccountIds?.[account.tool] || `local-${account.tool}`) === account.id;
  const description =
    account.kind === "local"
      ? copy.localProfileDescription
      : account.hasSecret
        ? copy.managedProfileWithKey
        : copy.managedProfileDescription;
  return (
    <ItemRow
      section="cli"
      id={account.id}
      selected={selected}
      navigate={navigate}
      icon={<ProviderMark tool={account.tool} />}
      label={account.name}
      sub={[names[account.tool], description, isDefault ? copy.defaultAccount : ""]
        .filter(Boolean)
        .join(" · ")}
      value={
        account.kind === "local"
          ? commonCopy.local
          : usageValue(usageEntry(usage, "cli-account", account.id))
      }
    />
  );
}

export default function AccountsHub({
  state,
  data,
  usage,
  agentsEnabled,
  selected,
  navigate,
  oauth,
  oauthResult,
  mcpNotice,
  focusMcp,
  authStates,
}) {
  const { runtime } = useAssistants();
  const ready = runtime.availability === "ready";
  const connections = state.providerConnections || [];
  const accounts = (state.accounts || []).filter((account) => account.tool !== "shell");
  const row = { selected, navigate };
  const speech = assistantCopy.speech;
  const webSearch = assistantCopy.webSearch;
  // An open MCP server shows the action feedback next to its buttons instead.
  const mcpDetail = ["mcp-server", "mcp-new"].includes(selected?.kind);
  return (
    <div className="accounts-hub">
      <p className="accounts-intro">{hubCopy.intro}</p>
      <HubGroup
        title={hubCopy.groups.models}
        hint={connectionCopy.description}
        action={{
          label: <AddLabel text={connectionCopy.add} />,
          onClick: () => navigate(itemRoute("models", "new")),
        }}
      >
        {(labelId) => (
          <>
            {agentsEnabled && <ErrorMessage error={data.chatgptError} />}
            {!connections.length && (
              <p className="accounts-note">{connectionCopy.empty}</p>
            )}
            <ListCard labelledBy={labelId}>
              {connections.map((connection) => (
                <ItemRow
                  key={connection.id}
                  section="models"
                  id={connection.id}
                  {...row}
                  label={connection.name}
                  sub={connectionSummary(connection).join(" · ")}
                  value={usageValue(usageEntry(usage, "connection", connection.id))}
                />
              ))}
              {agentsEnabled &&
                (data.chatgpt || []).map((account) => (
                  <ItemRow
                    key={account.id}
                    section="models"
                    id={account.id}
                    {...row}
                    label={account.name}
                    sub={hubCopy.chatgptSub(
                      assistantCopy.accountStatus[ready ? account.status : "offline"] ||
                        assistantCopy.accountStatus.unknown,
                    )}
                    value={usageValue(usageEntry(usage, "chatgpt", account.id))}
                  />
                ))}
              {agentsEnabled && (
                <ItemRow
                  section="models"
                  id="chatgpt"
                  {...row}
                  label={assistantCopy.accountsTitle}
                  sub={hubCopy.chatgptConnectSub}
                />
              )}
            </ListCard>
          </>
        )}
      </HubGroup>
      {agentsEnabled && (
        <HubGroup title={hubCopy.groups.services}>
          {(labelId) => (
            <>
              <ErrorMessage error={data.speechError} />
              <ErrorMessage error={data.webSearchError} />
              <ListCard labelledBy={labelId}>
                <ItemRow
                  section="services"
                  id="speech"
                  {...row}
                  label={speech.title}
                  sub={
                    data.speech
                      ? `${hubCopy.speechProvider} · ${data.speech.hasSecret ? speech.saved : speech.missing}`
                      : unknownValue
                  }
                  value={usageValue(usageEntry(usage, "speech"))}
                />
                <ItemRow
                  section="services"
                  id="web-search"
                  {...row}
                  label={webSearch.title}
                  sub={
                    data.webSearch
                      ? `${hubCopy.searchProviders[data.webSearch.provider] ?? data.webSearch.provider} · ${data.webSearch.ready ? webSearch.ready : hubCopy.notReady}`
                      : unknownValue
                  }
                  value={usageValue(usageEntry(usage, "web-search"))}
                />
              </ListCard>
            </>
          )}
        </HubGroup>
      )}
      <McpServersGroup
        servers={data.mcpServers}
        error={data.mcpError}
        feedback={!mcpDetail}
        notice={mcpNotice}
        oauth={oauth}
        oauthResult={oauthResult}
        focus={focusMcp}
        usage={usage}
        selected={selected}
        navigate={navigate}
      />
      <HubGroup
        title={hubCopy.groups.cli}
        action={{
          label: <AddLabel text={commonCopy.addAccount} />,
          onClick: () => navigate(itemRoute("cli", "new")),
        }}
      >
        {(labelId) => (
          <ListCard labelledBy={labelId}>
            {accounts.map((account) => (
              <NativeAccountRow
                key={account.id}
                account={account}
                auth={authOf(authStates, account)}
                state={state}
                usage={usage}
                {...row}
              />
            ))}
          </ListCard>
        )}
      </HubGroup>
    </div>
  );
}
