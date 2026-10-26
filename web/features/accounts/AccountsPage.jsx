import React, { Suspense, useCallback, useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import useReturnTarget from "../../app/useReturnTarget.js";
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
import { screenOf } from "../../app/route-screens.js";
import "./accounts-page.css";

const ids = (list) => (list || []).map((item) => item.id);

/**
 * Native CLI accounts (Coding › Accounts until Coding has its own page; model access,
 * services and MCP servers moved to Zugänge, ConnectionsPage.jsx); each entry opens
 * as a subpage (phones) or in the detail pane (desktop).
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
  // Opened through a cross-link (`returnTo`): moves inside Accounts keep it. On phones
  // only the page the link landed on leads back to its origin (other entries go up to
  // their group, a later hub shows the menu); on wider screens Accounts is one page
  // and keeps the origin's back arrow for the whole visit.
  const returnTo = route.returnTo;
  const returnTarget = useReturnTarget(route, onNavigate);
  const here = `${route.section}:${route.item}`;
  // The landing page follows each new `returnTo`, including history moves that keep
  // this page mounted.
  const [landing, setLanding] = useState({ returnTo, key: here });
  if (landing.returnTo !== returnTo) setLanding({ returnTo, key: here });
  const navigate = useCallback(
    (next, replace) =>
      onNavigate(
        returnTo && screenOf(next)?.view === "accounts" && !next.returnTo
          ? { ...next, returnTo }
          : next,
        replace,
      ),
    [onNavigate, returnTo],
  );
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
      data.pdfModel?.revision,
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
    if (missing) navigate(itemRoute(route.section), true);
  }, [missing, route.section, navigate]);
  const Detail = entry ? detailComponents[entry.kind] : null;
  const pending = entry?.kind === "loading" || entry?.kind === "error";
  const open = Boolean(Detail) || pending;
  const subpage = open && narrow;
  const toOrigin =
    Boolean(returnTarget) &&
    (!narrow || (landing.returnTo === returnTo ? landing.key : here) === here);
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
      leading={subpage || toOrigin ? "back" : "menu"}
      leadingLabel={toOrigin ? returnTarget.label : undefined}
      onLeading={
        toOrigin
          ? returnTarget.back
          : subpage
            ? () => navigate(itemRoute(entry.section))
            : openNavigation
      }
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
          navigate={navigate}
          authStates={authStates}
          groups={["cli"]}
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
                navigate={navigate}
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
