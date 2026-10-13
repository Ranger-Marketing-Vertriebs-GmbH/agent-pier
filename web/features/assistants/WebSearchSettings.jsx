import React, { useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { RadioRow, SelectRow } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { runSaveChain } from "../../lib/settings/save-chain.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import { accountItemTitle } from "../accounts/accounts-items.js";
import { restartNote } from "../accounts/account-usage-view.js";
import { assistantApi } from "./assistant-api.js";
import RestartConfirmation from "./RestartConfirmation.jsx";

const providers = ["duckduckgo", "perplexity", "brave"];

const serverOf = (settings) => ({
  provider: settings?.provider ?? "duckduckgo",
  connectionId: settings?.connectionId || "",
  braveKey: "",
});

/** The search provider agents use; keys are written here and never shown again. */
export default function WebSearchSettings({
  entry,
  usage,
  agentsEnabled,
  state,
  data,
  navigate,
}) {
  const copy = assistantCopy.webSearch;
  const settings = data.webSearch;
  const formRef = useRef(null);
  const [removal, setRemoval] = useState(null);
  const [error, setError] = useState("");
  const openRouter = (state.providerConnections || []).filter(
    (connection) => connection.providerId === "openrouter",
  );
  const { reloadWebSearch } = data;
  const server = useMemo(
    () => serverOf(settings),
    [settings?.provider, settings?.connectionId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const form = useAccountDraft({
    server,
    revisions: settings ? { webSearch: settings.revision } : {},
    refresh: async () => {
      const next = await reloadWebSearch();
      return next && { server: serverOf(next), revisions: { webSearch: next.revision } };
    },
    tab: accountItemTitle(entry),
    entry,
    steps: [
      {
        id: "web-search",
        label: copy.save,
        resource: "webSearch",
        async run({ values, revision, confirmations }) {
          const next = await assistantApi.saveWebSearch({
            revision,
            provider: values.provider,
            ...(values.provider === "perplexity" && values.connectionId
              ? { connectionId: values.connectionId }
              : {}),
            ...(values.provider === "brave" && values.braveKey
              ? { braveKey: values.braveKey }
              : {}),
            ...confirmations,
          });
          data.setWebSearch(next);
          return next;
        },
      },
    ],
  });
  const { draft } = form;
  const values = draft.values;
  // Any change withdraws an open restart question; it was about the previous state.
  const edit = (key, value) => {
    draft.confirmation?.cancel();
    draft.set(key, value);
  };
  async function removeKey() {
    setError("");
    const result = await runSaveChain({
      steps: [
        {
          id: "remove-key",
          label: copy.removeKey,
          run: ({ confirmations }) =>
            assistantApi.saveWebSearch({
              revision: settings.revision,
              provider: "brave",
              braveKey: null,
              ...confirmations,
            }),
        },
      ],
      values: {},
      base: {},
      ask: (request) =>
        new Promise((resolve) =>
          setRemoval({
            ...request,
            confirm: () => {
              setRemoval(null);
              resolve(true);
            },
            cancel: () => {
              setRemoval(null);
              resolve(false);
            },
          }),
        ),
    });
    if (result.status === "saved") data.setWebSearch(result.results["remove-key"]);
    else if (result.error) setError(result.error.message);
  }
  const restart = draft.confirmation?.kind === "restart" ? draft.confirmation : removal;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        values.provider === "brave" &&
        settings?.hasBraveKey && (
          <button
            type="button"
            className="button secondary danger-text"
            // Removing saves at once: unsaved changes would turn into a conflict.
            disabled={draft.saving || draft.dirty || Boolean(removal)}
            onClick={removeKey}
          >
            {copy.removeKey}
          </button>
        )
      }
      bar={
        <AccountSaveBar
          form={form}
          formRef={formRef}
          saveLabel={copy.save}
          note={restartNote(usage)}
        />
      }
    >
      <ErrorMessage error={error || data.webSearchError} />
      {settings && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <p className="accounts-note" role="status">
            {settings.ready ? copy.ready : copy.notConfigured}
          </p>
          <GroupLabel hint={copy.description}>{copy.provider}</GroupLabel>
          <ListCard label={copy.provider}>
            {providers.map((id) => (
              <RadioRow
                key={id}
                name="web-search-provider"
                value={id}
                label={copy[id]}
                checked={values.provider === id}
                onChange={(value) => edit("provider", value)}
              />
            ))}
          </ListCard>
          {values.provider === "perplexity" &&
            (openRouter.length ? (
              <ListCard>
                <SelectRow
                  label={copy.connection}
                  value={values.connectionId}
                  onChange={(value) => edit("connectionId", value)}
                  options={[
                    { value: "", label: copy.noConnection },
                    ...openRouter.map((connection) => ({
                      value: connection.id,
                      label: connection.name,
                    })),
                  ]}
                />
              </ListCard>
            ) : (
              <p className="accounts-note">{copy.noConnections}</p>
            ))}
          {values.provider === "brave" && (
            <>
              <p className="accounts-note" role="status">
                {settings.hasBraveKey ? copy.braveKeyStored : copy.braveKeyMissing}
              </p>
              <ListCard>
                <FieldRow label={copy.braveKey}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={1024}
                    value={values.braveKey}
                    onChange={(event) => edit("braveKey", event.target.value)}
                  />
                </FieldRow>
              </ListCard>
            </>
          )}
        </form>
      )}
      {restart && (
        <RestartConfirmation
          affected={restart.data?.affected}
          busy={false}
          onConfirm={restart.confirm}
          onCancel={restart.cancel}
        />
      )}
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
