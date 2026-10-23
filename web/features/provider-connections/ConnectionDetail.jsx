import React, { useMemo, useRef, useState } from "react";
import PendingRestartNotice from "../assistants/PendingRestartNotice.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { CheckboxRow } from "../../components/ListRow.jsx";
import useResource from "../../lib/useResource.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import KeyField from "../accounts/KeyField.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import useCreatedRedirect from "../accounts/useCreatedRedirect.js";
import useFieldSetter from "../accounts/useFieldSetter.js";
import { accountItemTitle, itemRoute } from "../accounts/accounts-items.js";
import { restartNote } from "../accounts/account-usage-view.js";
import ConnectionDeleteSheet from "./ConnectionDeleteSheet.jsx";
import ConnectionEndpointGroups from "./ConnectionEndpointGroups.jsx";
import ConnectionRestartBlock from "./ConnectionRestartBlock.jsx";
import useEndpointTest from "./useEndpointTest.js";
import { connectionSaveStep, connectionValues } from "./connection-save.js";
import {
  initialEndpoint,
  keyReentryRequired,
  modelsInvalid,
  withoutTest,
} from "./endpoint-draft.js";
import "./connections.css";

/** One central provider connection: create (item=new) or edit, use, delete. */
export default function ConnectionDetail({
  entry,
  usage,
  agentsEnabled,
  refresh,
  navigate,
}) {
  const connection = entry.kind === "connection" ? entry.record : null;
  const signature = JSON.stringify(connection);
  // The record changes identity on every refresh; its content decides the base.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const server = useMemo(() => connectionValues(connection), [signature]);
  const providers = useResource("/providers");
  const formRef = useRef(null);
  const [created, setCreated] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [probeModelId, setProbeModel] = useState("");
  const form = useAccountDraft({
    server,
    tab: accountItemTitle(entry),
    entry,
    steps: [
      connectionSaveStep({
        connection,
        label: copy.save,
        saved: async (result) => {
          await refresh();
          if (!connection) setCreated(result.id);
        },
      }),
    ],
  });
  const { draft } = form;
  const values = draft.values;
  useCreatedRedirect({ created, draft, navigate, section: "models" });
  const setEndpoint = useFieldSetter(draft, "endpoint");
  const endpoint = values.providerId === "endpoint";
  const tester = useEndpointTest({
    connection,
    draft: values.endpoint,
    apiKey: values.apiKey,
    removeApiKey: values.removeApiKey,
  });
  // Address, header, preset or key changes invalidate a test of the old values.
  const invalidateTest = () => {
    tester.reset();
    setEndpoint(withoutTest);
  };
  const editAddress = (update) => {
    tester.reset();
    setEndpoint((current) => withoutTest(update(current)));
  };
  const keyReentry =
    endpoint &&
    keyReentryRequired({
      connection,
      draft: values.endpoint,
      apiKey: values.apiKey,
      removeApiKey: values.removeApiKey,
    });
  const modelsBlocked = endpoint && modelsInvalid(values.endpoint.models);
  const options =
    providers.data?.providers ||
    (connection
      ? [
          {
            id: connection.providerId,
            name: copy.providerNames[connection.providerId] || connection.providerId,
          },
        ]
      : []);
  const clis = connection
    ? connection.tools.map((tool) => ({
        tool,
        route: connection.toolRoutes ? connection.toolRoutes[tool] : undefined,
      }))
    : null;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        connection && (
          <button
            type="button"
            className="button secondary danger-text"
            onClick={() => setDeleting(true)}
          >
            {copy.delete}
          </button>
        )
      }
      bar={
        <AccountSaveBar
          form={form}
          formRef={formRef}
          saveLabel={copy.save}
          note={restartNote(usage)}
          saveDisabled={keyReentry || modelsBlocked || (!connection && !providers.data)}
        />
      }
    >
      <form
        ref={formRef}
        className="accounts-detail-group"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset className="connection-fields" disabled={draft.saving}>
          <ListCard>
            <FieldRow label={copy.name}>
              <input
                required
                maxLength={100}
                autoFocus={!connection}
                value={values.name}
                onChange={(event) => draft.set("name", event.target.value)}
              />
            </FieldRow>
            <FieldRow label={copy.provider}>
              <AnchoredSelect
                label={copy.provider}
                value={values.providerId}
                disabled={Boolean(connection) || providers.loading}
                required
                onChange={(value) => {
                  draft.update({
                    providerId: value,
                    responsesAccess: false,
                    apiKey: "",
                    endpoint: initialEndpoint(null),
                  });
                  setProbeModel("");
                  tester.reset();
                }}
                options={options.map((provider) => ({
                  value: provider.id,
                  label: copy.providerNames[provider.id] || provider.name,
                }))}
              />
            </FieldRow>
            <KeyField
              label={copy.key}
              saved={Boolean(connection?.hasSecret)}
              savedText={copy.keySaved}
              value={values.apiKey}
              disabled={values.removeApiKey}
              placeholder={
                connection?.hasSecret
                  ? copy.keyPlaceholder
                  : endpoint
                    ? copy.endpoint.keyOptional
                    : copy.keyOptional
              }
              hint={copy.keyHelp}
              resetKey={form.generation}
              onChange={(value) => {
                draft.set("apiKey", value);
                if (endpoint) invalidateTest();
              }}
            />
            {connection?.hasSecret && (
              <CheckboxRow
                label={copy.removeKey}
                checked={values.removeApiKey}
                onChange={(checked) => {
                  draft.update({
                    removeApiKey: checked,
                    ...(checked ? { apiKey: "" } : {}),
                  });
                  if (endpoint) invalidateTest();
                }}
              />
            )}
            {values.providerId !== "openrouter" && !endpoint && (
              <CheckboxRow
                label={copy.responses}
                sub={copy.responsesHelp}
                checked={values.responsesAccess}
                onChange={(checked) => draft.set("responsesAccess", checked)}
              />
            )}
          </ListCard>
          {providers.loading && !connection && <p role="status">{copy.loading}</p>}
          <ErrorMessage error={providers.error} />
          {keyReentry && <p role="alert">{copy.endpoint.keyReentry}</p>}
          {endpoint && (
            <ConnectionEndpointGroups
              endpoint={values.endpoint}
              setEndpoint={setEndpoint}
              editAddress={editAddress}
              tester={tester}
              probeModelId={probeModelId}
              setProbeModel={setProbeModel}
            />
          )}
        </fieldset>
      </form>
      {draft.confirmation?.kind === "restart" && (
        <ConnectionRestartBlock confirmation={draft.confirmation} />
      )}
      <PendingRestartNotice />
      {connection && (
        <UsedByGroup
          usage={usage}
          agentsEnabled={agentsEnabled}
          navigate={navigate}
          clis={clis}
        />
      )}
      {connection && (
        <ConnectionDeleteSheet
          connection={connection}
          open={deleting}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            await refresh();
            form.leave(navigate, itemRoute("models"));
          }}
        />
      )}
    </AccountDetail>
  );
}
