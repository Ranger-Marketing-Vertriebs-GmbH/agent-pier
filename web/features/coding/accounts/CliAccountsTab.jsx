import React, { Suspense, useCallback, useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import {
  InfoHintButton,
  InfoHintText,
  useInfoHint,
} from "../../../components/InfoHint.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import ProviderMark from "../../../components/ProviderMark.jsx";
import { routePath } from "../../../app/routes.js";
import { screenOf } from "../../../app/route-screens.js";
import useReturnTarget from "../../../app/useReturnTarget.js";
import {
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../../lib/i18n/messages/accounts.js";
import { codingPageCopy } from "../../../lib/i18n/messages/coding.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { names } from "../../../lib/providers.js";
import AddLabel from "../../accounts/AddLabel.jsx";
import { usageEntry, usageValue } from "../../accounts/account-usage-view.js";
import useAccountUsage from "../../accounts/useAccountUsage.js";
import useNarrowViewport from "../../accounts/useNarrowViewport.js";
import useAssistantFeature from "../../assistants/useAssistantFeature.js";
import CodingFrame from "../CodingFrame.jsx";
import {
  cliAccountRoute,
  cliAccountTitle,
  isDefaultAccount,
  nativeAccounts,
  resolveCliAccount,
} from "./cli-accounts.js";
import NativeAccountDetail from "./NativeAccountDetail.jsx";
import useAccountAuthStates, { authOf } from "./useAccountAuthStates.js";
import "../../accounts/accounts-page.css";

const ids = (list) => (list || []).map((item) => item.id);

// A local profile appears once its CLI login is confirmed (polled every 10 s).
function NativeAccountRow({ account, auth, state, usage, selected, navigate }) {
  if (account.kind === "local" && auth !== "authenticated") return null;
  const route = cliAccountRoute(account.id);
  const current = selected?.item === account.id;
  const description =
    account.kind === "local"
      ? copy.localProfileDescription
      : account.hasSecret
        ? copy.managedProfileWithKey
        : copy.managedProfileDescription;
  return (
    <ListRow
      href={routePath(route)}
      onClick={() => navigate(route)}
      current={current}
      className={current ? "is-selected" : ""}
      icon={<ProviderMark tool={account.tool} />}
      label={account.name}
      sub={[
        names[account.tool],
        description,
        isDefaultAccount(state, account) ? copy.defaultAccount : "",
      ]
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

/**
 * Coding › Accounts: native CLI accounts (moved from Accounts). The list and one
 * account's detail sit side by side; on phones the detail is a subpage. Opened
 * through a cross-link (`returnTo`), moves inside the tab keep it: on phones only the
 * page the link landed on leads back to its origin, on wider screens the whole visit.
 */
export default function CliAccountsTab({
  frame,
  state,
  ready = true,
  act,
  refresh,
  route,
  onNavigate,
}) {
  const labelId = useId();
  const returnTo = route.returnTo;
  const returnTarget = useReturnTarget(route, onNavigate);
  const here = route.item || "";
  const [landing, setLanding] = useState({ returnTo, key: here });
  if (landing.returnTo !== returnTo) setLanding({ returnTo, key: here });
  const navigate = useCallback(
    (next, replace) => {
      const screen = screenOf(next);
      return onNavigate(
        returnTo &&
          screen?.view === "coding" &&
          screen.codingTab === "accounts" &&
          !next.returnTo
          ? { ...next, returnTo }
          : next,
        replace,
      );
    },
    [onNavigate, returnTo],
  );
  const feature = useAssistantFeature();
  const agentsEnabled = !feature.loading && Boolean(feature.enabled);
  const accounts = nativeAccounts(ready ? state.accounts : null);
  const usage = useAccountUsage(JSON.stringify([agentsEnabled, ids(state.accounts)]));
  const authStates = useAccountAuthStates(state.accounts);
  const entry = resolveCliAccount(route.item, accounts);
  const narrow = useNarrowViewport();
  const info = useInfoHint();
  const missing = entry?.kind === "missing";
  useEffect(() => {
    if (missing) navigate(cliAccountRoute(), true);
  }, [missing, navigate]);
  const open = Boolean(entry) && !missing;
  const subpage = open && narrow;
  const toOrigin =
    Boolean(returnTarget) &&
    (!narrow || (landing.returnTo === returnTo ? landing.key : here) === here);
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
    <CodingFrame
      {...frame}
      className="accounts-page"
      subpage={subpage}
      title={subpage ? cliAccountTitle(entry) || hubCopy.groups.cli : undefined}
      subtitle={subpage ? codingPageCopy.breadcrumb(codingPageCopy.tabs.accounts) : local}
      leading={subpage || toOrigin ? "back" : "menu"}
      leadingLabel={toOrigin ? returnTarget.label : undefined}
      onLeading={
        toOrigin
          ? returnTarget.back
          : subpage
            ? () => navigate(cliAccountRoute())
            : frame.onLeading
      }
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
        <div className="accounts-hub">
          <p className="coding-hint">{codingPageCopy.accountsHint}</p>
          <section className="accounts-group" aria-labelledby={labelId}>
            <GroupLabel
              id={labelId}
              action={{
                label: <AddLabel text={commonCopy.addAccount} />,
                onClick: () => navigate(cliAccountRoute("new")),
              }}
            >
              {hubCopy.groups.cli}
            </GroupLabel>
            {accounts ? (
              <ListCard labelledBy={labelId}>
                {accounts.map((account) => (
                  <NativeAccountRow
                    key={account.id}
                    account={account}
                    auth={authOf(authStates, account)}
                    state={state}
                    usage={usage}
                    selected={entry}
                    navigate={navigate}
                  />
                ))}
              </ListCard>
            ) : (
              loadingLine
            )}
          </section>
        </div>
        <div className="accounts-pane">
          {entry?.kind === "cli-account" || entry?.kind === "cli-new" ? (
            <Suspense fallback={loadingLine}>
              <NativeAccountDetail
                key={entry.item}
                entry={entry}
                usage={usageEntry(usage, entry.kind, entry.item)}
                agentsEnabled={agentsEnabled}
                state={state}
                refresh={refresh}
                navigate={navigate}
                act={act}
                authStates={authStates}
              />
            </Suspense>
          ) : entry?.kind === "loading" ? (
            loadingLine
          ) : (
            <p className="accounts-empty">{hubCopy.selectHint}</p>
          )}
        </div>
      </div>
    </CodingFrame>
  );
}
