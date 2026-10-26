import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnchoredSelect from "../../../components/AnchoredSelect.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { CheckboxRow } from "../../../components/ListRow.jsx";
import { names } from "../../../lib/providers.js";
import { sameValue } from "../../../lib/settings/draft-state.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../../lib/i18n/messages/connections.js";
import { providerCopy } from "../../../lib/i18n/messages/providers.js";
import {
  accountDialogCopy as dialogCopy,
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../../lib/i18n/messages/accounts.js";
import ProviderAccountSummary from "../../providers/ProviderAccountSummary.jsx";
import AccountDetail, { AccountSaveBar } from "../../accounts/AccountDetail.jsx";
import FieldRow from "../../accounts/FieldRow.jsx";
import LegacyProviderEditor from "./LegacyProviderEditor.jsx";
import NativeAccountActions from "./NativeAccountActions.jsx";
import UsedByGroup from "../../accounts/UsedByGroup.jsx";
import { authOf } from "./useAccountAuthStates.js";
import useAccountDraft from "../../accounts/useAccountDraft.js";
import { cliAccountRoute, cliAccountTitle } from "./cli-accounts.js";
import {
  keyChangeRequired,
  nativeAccountStep,
  nativeAccountValues,
} from "./native-account-save.js";

function SignInGroup({ account, auth, state, act, refresh }) {
  if (account.provider || account.internal) return null;
  return (
    <section className="accounts-detail-group">
      <GroupLabel>{hubCopy.accountActions}</GroupLabel>
      <div className="account-actions accounts-actions-row">
        <NativeAccountActions
          account={account}
          auth={auth}
          state={state}
          act={act}
          refresh={refresh}
        />
      </div>
    </section>
  );
}

/** A native CLI account (Coding › Accounts): local profiles read only, managed ones editable. */
export default function NativeAccountDetail({
  entry,
  usage,
  agentsEnabled,
  state,
  refresh,
  navigate,
  act,
  authStates,
}) {
  const account = entry.kind === "cli-account" ? entry.record : null;
  const managed = !account || account.kind === "managed";
  const signature = JSON.stringify([account?.id, account?.name, account?.provider]);
  const server = useMemo(
    () => nativeAccountValues(account, state.tools),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  const formRef = useRef(null);
  const [created, setCreated] = useState(null);
  const [legacy, setLegacy] = useState({
    ready: true,
    providerId: account?.provider?.id || "",
  });
  const [generation, setGeneration] = useState(0);
  const reported = useRef(null);
  const form = useAccountDraft({
    server,
    tab: cliAccountTitle(entry),
    entry,
    steps: [
      nativeAccountStep({
        account,
        label: account ? commonCopy.save : commonCopy.createAccount,
        saved: async (result) => {
          await refresh();
          if (!account) setCreated(result.id);
        },
      }),
    ],
  });
  const { draft } = form;
  const values = draft.values;
  const live = useRef(draft);
  live.current = draft;
  // After a create, show the new account in place of the empty form (Back skips it).
  useEffect(() => {
    if (created && !draft.dirty) navigate(cliAccountRoute(created), true);
  }, [created, draft.dirty, navigate]);
  const onLegacy = useCallback(({ value, ready, providerId }) => {
    reported.current = value;
    setLegacy({ ready, providerId });
    if (!sameValue(live.current.values.provider, value))
      live.current.set("provider", value);
  }, []);
  // Cancel or a saved change returns `provider` to null: start the editor afresh.
  useEffect(() => {
    if (values.provider === null && reported.current !== null) {
      reported.current = null;
      setGeneration((value) => value + 1);
    }
  }, [values.provider]);
  const description = !account
    ? ""
    : account.kind === "local"
      ? copy.localProfileDescription
      : account.hasSecret
        ? copy.managedProfileWithKey
        : copy.managedProfileDescription;
  const keyChange = keyChangeRequired(values, account, legacy.providerId);
  const tools = (state.tools || []).filter((item) => item.id !== "shell");
  return (
    <AccountDetail
      title={cliAccountTitle(entry)}
      destructive={
        account?.kind === "managed" && (
          <button
            type="button"
            className="button secondary danger-text"
            onClick={() => act("deleteAccount", account)}
          >
            {commonCopy.deleteAccount}
          </button>
        )
      }
      bar={
        managed && (
          <AccountSaveBar
            form={form}
            formRef={formRef}
            saveLabel={account ? commonCopy.save : commonCopy.createAccount}
            saveDisabled={!legacy.ready || keyChange}
          />
        )
      }
    >
      {account && (
        <ListCard>
          <ListRow
            icon={<Icon name="shield" size={14} />}
            label={names[account.tool]}
            sub={description}
            value={account.kind === "local" ? commonCopy.local : undefined}
          />
        </ListCard>
      )}
      {account && (
        <SignInGroup
          account={account}
          auth={authOf(authStates, account)}
          state={state}
          act={act}
          refresh={refresh}
        />
      )}
      {account?.provider && (
        <section className="accounts-detail-group">
          <p className="field-description">{connectionCopy.legacy}</p>
          <ProviderAccountSummary account={account} />
        </section>
      )}
      {managed && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <fieldset disabled={draft.saving}>
            <p className="field-description">{dialogCopy.profileIsolationDescription}</p>
            <ListCard>
              <FieldRow label={commonCopy.accountName}>
                <input
                  name="name"
                  required
                  autoFocus={!account}
                  maxLength={100}
                  value={values.name}
                  placeholder={dialogCopy.accountNamePlaceholder}
                  onChange={(event) => draft.set("name", event.target.value)}
                />
              </FieldRow>
              {!account && (
                <FieldRow label={dialogCopy.toolLabel}>
                  <AnchoredSelect
                    label={dialogCopy.toolLabel}
                    value={values.tool}
                    onChange={(tool) => draft.set("tool", tool)}
                    options={tools.map((item) => ({
                      value: item.id,
                      label:
                        item.name +
                        (!item.installed ? dialogCopy.uninstalledToolSuffix : ""),
                    }))}
                  />
                </FieldRow>
              )}
              <FieldRow label={dialogCopy.apiKeyLabel}>
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  value={values.apiKey}
                  disabled={values.removeApiKey}
                  placeholder={
                    account?.hasSecret
                      ? dialogCopy.savedKeyPlaceholder
                      : dialogCopy.nativeKeyPlaceholder
                  }
                  onChange={(event) => draft.set("apiKey", event.target.value)}
                />
              </FieldRow>
              {account?.hasSecret && (
                <CheckboxRow
                  label={providerCopy.keyRemove}
                  checked={values.removeApiKey}
                  onChange={(checked) =>
                    draft.update({
                      removeApiKey: checked,
                      ...(checked ? { apiKey: "" } : {}),
                    })
                  }
                />
              )}
            </ListCard>
            {account?.provider && (
              <LegacyProviderEditor
                key={generation}
                account={account}
                onChange={onLegacy}
              />
            )}
            {keyChange && <p className="field-description">{providerCopy.switchKey}</p>}
            <p className="field-description">
              {legacy.providerId
                ? providerCopy.keyHelp
                : dialogCopy.nativeAuthenticationHelp}
            </p>
            <div className="form-note">
              <Icon name="shield" />
              {dialogCopy.formNote}
            </div>
          </fieldset>
        </form>
      )}
      {account && (
        <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
      )}
    </AccountDetail>
  );
}
