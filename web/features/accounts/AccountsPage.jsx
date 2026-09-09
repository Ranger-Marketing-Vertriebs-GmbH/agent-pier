import useAccountAuthStatus from "./useAccountAuthStatus.js";
import NativeAccountActions from "./NativeAccountActions.jsx";
import ProviderConnections from "../provider-connections/ProviderConnections.jsx";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { accountsPageCopy as copy } from "../../lib/i18n/messages/accounts.js";
import React from "react";
import ProviderAccountSummary from "../providers/ProviderAccountSummary.jsx";
import { names } from "../../lib/providers.js";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
export default function AccountsPage({ state, setModal, act, refresh }) {
  return (
    <div className="page accounts-page">
      <div className="page-topline">
        <span>{copy.pageToplineLabel}</span>
        <span className="subtle">
          <Icon name="shield" size={13} />
          {copy.subtle}
        </span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{copy.pageHeadingTitle}</h1>
          <p>{connectionCopy.accountDescription}</p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            setModal({
              type: "account",
            })
          }
        >
          <Icon name="plus" />
          {commonCopy.addAccount}
        </button>
      </header>
      <ProviderConnections
        connections={state.providerConnections || []}
        refresh={refresh}
      />
      <h2>{connectionCopy.native}</h2>
      <div className="account-list">
        {state.accounts
          .filter((a) => a.tool !== "shell")
          .map((a) => (
            <AccountCard
              key={a.id}
              a={a}
              state={state}
              setModal={setModal}
              act={act}
              refresh={refresh}
            />
          ))}
      </div>
      <div className="account-info">
        <Icon name="shield" size={22} />
        <div>
          <h3>{copy.accountInfoHeading}</h3>
          <p>{copy.accountInfoDescription}</p>
        </div>
      </div>
    </div>
  );
}

function AccountCard({ a, state, setModal, act, refresh }) {
  const auth = useAccountAuthStatus(a);
  if (a.kind === "local" && auth !== "authenticated") return null;
  return (
    <article className="account-card">
      <ProviderMark tool={a.tool} />
      <div className="account-details">
        <h2>{a.name}</h2>
        <p>
          {names[a.tool]}
          <span> · </span>
          {a.kind === "local"
            ? copy.localProfileDescription
            : a.hasSecret
              ? copy.managedProfileWithKey
              : copy.managedProfileDescription}
        </p>
        {a.provider && (
          <>
            <p className="field-description">{connectionCopy.legacy}</p>
            <ProviderAccountSummary account={a} />
          </>
        )}
      </div>
      <div className="account-actions">
        <NativeAccountActions
          account={a}
          auth={auth}
          state={state}
          act={act}
          refresh={refresh}
        />
        {a.kind === "managed" && (
          <>
            <button
              className="icon-button"
              aria-label={commonCopy.editNamedItem(a.name)}
              onClick={() =>
                setModal({
                  type: "account",
                  item: a,
                })
              }
            >
              <Icon name="edit" size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={copy.iconButtonAriaLabel(a.name)}
              onClick={() => act("deleteAccount", a)}
            >
              <Icon name="trash" size={16} />
            </button>
          </>
        )}
        {a.kind === "local" && <span className="badge">{commonCopy.local}</span>}
      </div>
    </article>
  );
}
