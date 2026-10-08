import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useResource from "../../lib/useResource.js";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import EndpointFields from "./EndpointFields.jsx";
import EndpointTestResult from "./EndpointTestResult.jsx";
import EndpointModelTable from "./EndpointModelTable.jsx";
import EndpointRouting from "./EndpointRouting.jsx";
import EndpointAdapterOptions from "./EndpointAdapterOptions.jsx";
import useEndpointTest from "./useEndpointTest.js";
import {
  applyProposal,
  endpointPayload,
  initialEndpoint,
  keyReentryRequired,
  modelsInvalid,
  withoutTest,
} from "./endpoint-draft.js";
export default function ConnectionDialog({ connection, close, saved }) {
  const [name, setName] = useState(connection?.name || ""),
    [providerId, setProvider] = useState(connection?.providerId || "openrouter"),
    [apiKey, setKey] = useState(""),
    [removeApiKey, setRemove] = useState(false),
    [responsesAccess, setResponses] = useState(Boolean(connection?.responsesAccess));
  const [draft, setDraft] = useState(() => initialEndpoint(connection)),
    [probeModelId, setProbeModel] = useState("");
  const providers = useResource("/providers"),
    action = useAsyncAction();
  const endpoint = providerId === "endpoint";
  const tester = useEndpointTest({ connection, draft, apiKey, removeApiKey });
  const keyReentry =
    endpoint && keyReentryRequired({ connection, draft, apiKey, removeApiKey });
  // Address, header, preset or key changes invalidate a test of the old values.
  const invalidateTest = () => {
    tester.reset();
    setDraft(withoutTest);
  };
  const editAddress = (update) => {
    tester.reset();
    setDraft((current) => withoutTest(update(current)));
  };
  const modelsBlocked = endpoint && modelsInvalid(draft.models);
  // A test model that left the list falls back to "Automatic".
  const activeProbeModel = draft.models.some((model) => model.modelId === probeModelId)
    ? probeModelId
    : "";
  const dismiss = () => {
    if (!action.lock.current) close();
  };
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
  return (
    <Modal
      title={connection ? copy.edit : copy.add}
      close={dismiss}
      closeDisabled={action.busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            const body = {
              name: name.trim(),
              ...(!connection ? { providerId } : {}),
              ...(apiKey ? { apiKey } : {}),
              ...(removeApiKey ? { removeApiKey: true } : {}),
              ...(providerId !== "openrouter" &&
              !endpoint &&
              (!connection || responsesAccess !== Boolean(connection.responsesAccess))
                ? { responsesAccess }
                : {}),
              ...(endpoint ? { endpoint: endpointPayload(draft) } : {}),
            };
            await api(
              connection
                ? `/provider-connections/${encodeURIComponent(connection.id)}`
                : "/provider-connections",
              connection ? "PATCH" : "POST",
              body,
            );
            setKey("");
            await saved();
            close();
          });
        }}
      >
        <div className="form-content">
          <fieldset className="connection-fields" disabled={action.busy}>
            <p className="field-description">{copy.description}</p>
            <label>
              {copy.name}
              <input
                required
                maxLength={100}
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              {copy.provider}
              <AnchoredSelect
                label={copy.provider}
                value={providerId}
                disabled={Boolean(connection) || providers.loading}
                required
                onChange={(value) => {
                  setProvider(value);
                  setResponses(false);
                  setKey("");
                  setDraft(initialEndpoint(null));
                  setProbeModel("");
                  tester.reset();
                }}
                options={options.map((provider) => ({
                  value: provider.id,
                  label: copy.providerNames[provider.id] || provider.name,
                }))}
              />
            </label>
            {endpoint && (
              <EndpointFields draft={draft} setDraft={editAddress} locked={false} />
            )}
            {providers.loading && !connection && <p role="status">{copy.loading}</p>}
            <ErrorMessage error={providers.error} />
            <label>
              {copy.key}
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                disabled={removeApiKey}
                placeholder={
                  connection?.hasSecret
                    ? copy.keyPlaceholder
                    : endpoint
                      ? copy.endpoint.keyOptional
                      : copy.keyOptional
                }
                onChange={(event) => {
                  setKey(event.target.value);
                  if (endpoint) invalidateTest();
                }}
              />
            </label>
            {keyReentry && <p role="alert">{copy.endpoint.keyReentry}</p>}
            {connection?.hasSecret && (
              <label className="provider-check">
                <input
                  type="checkbox"
                  checked={removeApiKey}
                  onChange={(event) => {
                    setRemove(event.target.checked);
                    if (event.target.checked) setKey("");
                    if (endpoint) invalidateTest();
                  }}
                />
                <span>{copy.removeKey}</span>
              </label>
            )}
            {endpoint && (
              <>
                <div className="endpoint-test">
                  <label>
                    {copy.endpoint.probeModel}
                    <AnchoredSelect
                      label={copy.endpoint.probeModel}
                      value={activeProbeModel}
                      onChange={setProbeModel}
                      options={[
                        { value: "", label: copy.endpoint.probeAuto },
                        ...draft.models.map((model) => ({
                          value: model.modelId,
                          label: model.modelId,
                        })),
                      ]}
                    />
                    <small>{copy.endpoint.probeHint}</small>
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={tester.busy || !draft.openaiBaseUrl.trim()}
                    onClick={async () => {
                      const proposal = await tester.run(activeProbeModel);
                      if (proposal)
                        setDraft((current) => applyProposal(current, proposal));
                    }}
                  >
                    {tester.busy ? copy.endpoint.testing : copy.endpoint.test}
                  </button>
                  <small>{copy.endpoint.testCost}</small>
                  <ErrorMessage error={tester.error} />
                </div>
                <EndpointTestResult
                  draft={draft}
                  setDraft={setDraft}
                  result={tester.result}
                />
                <EndpointRouting draft={draft} setDraft={setDraft} />
                <EndpointAdapterOptions draft={draft} setDraft={setDraft} />
                <EndpointModelTable draft={draft} setDraft={setDraft} />
              </>
            )}
            {providerId !== "openrouter" && !endpoint && (
              <label className="provider-check">
                <input
                  type="checkbox"
                  aria-label={copy.responses}
                  checked={responsesAccess}
                  onChange={(event) => setResponses(event.target.checked)}
                />
                <span>
                  {copy.responses}
                  <small>{copy.responsesHelp}</small>
                </span>
              </label>
            )}
            <p className="field-description">{copy.keyHelp}</p>
          </fieldset>
          <ErrorMessage error={action.error} />
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={dismiss}
          >
            {commonCopy.cancel}
          </button>
          <button
            className="button primary"
            disabled={
              action.busy ||
              keyReentry ||
              modelsBlocked ||
              (!connection && !providers.data)
            }
          >
            {copy.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
