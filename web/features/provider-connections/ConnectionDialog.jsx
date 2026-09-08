import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useResource from "../../lib/useResource.js";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
export default function ConnectionDialog({ connection, close, saved }) {
  const [name, setName] = useState(connection?.name || ""),
    [providerId, setProvider] = useState(connection?.providerId || "openrouter"),
    [apiKey, setKey] = useState(""),
    [removeApiKey, setRemove] = useState(false),
    [responsesAccess, setResponses] = useState(Boolean(connection?.responsesAccess));
  const providers = useResource("/providers"),
    action = useAsyncAction();
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
              (!connection || responsesAccess !== Boolean(connection.responsesAccess))
                ? { responsesAccess }
                : {}),
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
                }}
                options={options.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                }))}
              />
            </label>
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
                  connection?.hasSecret ? copy.keyPlaceholder : copy.keyOptional
                }
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            {connection?.hasSecret && (
              <label className="provider-check">
                <input
                  type="checkbox"
                  checked={removeApiKey}
                  onChange={(event) => {
                    setRemove(event.target.checked);
                    if (event.target.checked) setKey("");
                  }}
                />
                <span>{copy.removeKey}</span>
              </label>
            )}
            {providerId !== "openrouter" && (
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
            disabled={action.busy || (!connection && !providers.data)}
          >
            {copy.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
