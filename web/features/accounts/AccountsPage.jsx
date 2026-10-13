import React, { Suspense, useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import Icon from "../../components/Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import {
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../lib/i18n/messages/accounts.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import useAssistants from "../assistants/useAssistants.js";
import { useMcpOAuth } from "../mcp-servers/McpOAuthLogin.jsx";
import AccountsHub from "./AccountsHub.jsx";
import { detailComponents } from "./account-details.js";
import {
  accountItemTitle,
  itemRoute,
  resolveAccountItem,
  sectionLabel,
} from "./accounts-items.js";
import { usageEntry } from "./account-usage-view.js";
import useAccountAuthStates from "./useAccountAuthStates.js";
import useAccountUsage from "./useAccountUsage.js";
import useAccountsData from "./useAccountsData.js";
import useNarrowViewport from "./useNarrowViewport.js";
import "./accounts-page.css";

const ids = (list) => (list || []).map((item) => item.id);

/**
 * Accounts: a hub of four groups (models, services for agents, MCP servers, native CLI
 * accounts); each entry opens as a subpage (phones) or in the detail pane (desktop).
 * Detail components receive DetailProps:
 * { entry, usage, agentsEnabled, state, data, refresh, navigate, act, oauth, mcpNotice,
 *   notifyMcp, authStates }.
 */
export default function AccountsPage({
  state,
  ready = true,
  act,
  refresh,
  route,
  onNavigate,
  openNavigation,
  navigationOpen = false,
}) {
  const feature = useAssistantFeature();
  const agentsEnabled = feature.loading ? null : Boolean(feature.enabled);
  const { runtime } = useAssistants();
  const data = useAccountsData({
    agentsEnabled: agentsEnabled === true,
    runtimeReady: runtime.availability === "ready",
  });
  const [mcpNotice, setMcpNotice] = useState("");
  const oauth = useMcpOAuth({ reload: data.reloadMcp, notify: setMcpNotice });
  const authStates = useAccountAuthStates(state.accounts);
  const usage = useAccountUsage(
    JSON.stringify([
      agentsEnabled,
      ids(state.providerConnections),
      ids(state.accounts),
      (data.mcpServers || []).map((server) => [server.id, server.revision]),
      ids(data.chatgpt),
      data.speech?.revision,
      data.webSearch?.revision,
    ]),
  );
  const entry = resolveAccountItem(route, {
    agentsEnabled,
    connections: ready ? (state.providerConnections ?? null) : null,
    accounts: ready ? state.accounts : null,
    chatgpt: data.chatgpt,
    mcpServers: data.mcpServers,
    errors: { chatgpt: data.chatgptError, mcpServers: data.mcpError },
  });
  const narrow = useNarrowViewport();
  const info = useInfoHint();
  const missing = entry?.kind === "missing";
  useEffect(() => {
    if (missing) onNavigate(itemRoute(route.section), true);
  }, [missing, route.section, onNavigate]);
  const Detail = entry ? detailComponents[entry.kind] : null;
  const pending = entry?.kind === "loading" || entry?.kind === "error";
  const open = Boolean(Detail) || pending;
  const subpage = open && narrow;
  // A loading or failed entry has no name yet; its group names the subpage.
  const title = subpage
    ? accountItemTitle(entry) || sectionLabel(entry.section)
    : copy.pageHeadingTitle;
  const retry = () =>
    (entry.record.source === "chatgpt" ? data.reloadChatgpt() : data.reloadMcp()).catch(
      () => {},
    );
  const local = (
    <span className="accounts-local">
      <Icon name="shield" size={12} />
      {copy.subtle.trim()}
    </span>
  );
  const loadingLine = (
    <p className="loading" role="status">
      {hubCopy.loading}
    </p>
  );
  return (
    <SettingsShell
      className="accounts-page"
      title={title}
      subtitle={subpage ? hubCopy.breadcrumb(sectionLabel(entry.section)) : local}
      description={hubCopy.intro}
      leading={subpage ? "back" : "menu"}
      onLeading={subpage ? () => onNavigate(itemRoute(entry.section)) : openNavigation}
      navigationOpen={navigationOpen}
      actions={
        subpage ? null : (
          <>
            {local}
            <InfoHintButton hint={info} label={hubCopy.infoLabel} />
          </>
        )
      }
    >
      {!subpage && (
        <InfoHintText hint={info}>
          <strong>{copy.accountInfoHeading}</strong> {copy.accountInfoDescription}
        </InfoHintText>
      )}
      <div className={["accounts-layout", open ? "has-detail" : ""].join(" ").trim()}>
        <AccountsHub
          state={state}
          data={data}
          usage={usage}
          agentsEnabled={agentsEnabled === true}
          selected={entry}
          navigate={onNavigate}
          oauth={oauth}
          oauthResult={route.mcpOAuth}
          mcpNotice={mcpNotice}
          focusMcp={route.section === "mcp-servers" && !route.item}
          authStates={authStates}
        />
        <div className="accounts-pane">
          {Detail ? (
            <Suspense fallback={loadingLine}>
              <Detail
                key={`${entry.section}:${entry.item}`}
                entry={entry}
                usage={usageEntry(usage, entry.kind, entry.item)}
                agentsEnabled={agentsEnabled === true}
                state={state}
                data={data}
                refresh={refresh}
                navigate={onNavigate}
                act={act}
                oauth={oauth}
                mcpNotice={mcpNotice}
                notifyMcp={setMcpNotice}
                authStates={authStates}
              />
            </Suspense>
          ) : entry?.kind === "loading" ? (
            loadingLine
          ) : entry?.kind === "error" ? (
            <div className="accounts-detail-error">
              <ErrorMessage error={entry.record.error} />
              <button type="button" className="button secondary" onClick={retry}>
                {commonCopy.retry}
              </button>
            </div>
          ) : (
            <p className="accounts-empty">{hubCopy.selectHint}</p>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}
