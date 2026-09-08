import React, { useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ProviderModelPicker from "../providers/ProviderModelPicker.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";

export default function ProfileProviderFields({
  config,
  patch,
  resource,
  connection,
  catalog,
}) {
  const [query, setQuery] = useState("");
  const connections = (resource.data?.connections || []).filter((item) =>
    item.tools.includes(config.cliTool),
  );
  return (
    <>
      <label>
        {copy.providerConnection}
        <AnchoredSelect
          label={copy.providerConnection}
          value={config.providerConnectionId || ""}
          disabled={resource.loading}
          onChange={(value) => {
            setQuery("");
            patch({
              providerConnectionId: value || undefined,
              models: { available: [""], default: "" },
            });
          }}
          options={[
            { value: "", label: copy.accountAccess },
            ...(config.providerConnectionId && !connection
              ? [
                  {
                    value: config.providerConnectionId,
                    label: copy.connectionUnavailable,
                    disabled: true,
                  },
                ]
              : []),
            ...connections.map((item) => ({ value: item.id, label: item.name })),
          ]}
        />
      </label>
      <ErrorMessage error={resource.error} />
      {resource.error && (
        <button type="button" className="button secondary" onClick={resource.refresh}>
          {copy.retryConnections}
        </button>
      )}
      {config.providerConnectionId && !connection && !resource.loading && (
        <p role="alert">{copy.connectionUnavailable}</p>
      )}
      {connection && (
        <>
          <p className="field-description">{copy.connectionHelp}</p>
          {!connection.hasSecret && (
            <p className="field-description">{copy.connectionKeyMissing}</p>
          )}
          <ProviderModelPicker
            catalog={catalog}
            tool={config.cliTool}
            query={query}
            setQuery={setQuery}
            modelId={config.models.default}
            setModel={(modelId) =>
              patch({
                models: {
                  available: [
                    ...new Set([...config.models.available.filter(Boolean), modelId]),
                  ],
                  default: modelId,
                },
              })
            }
          />
        </>
      )}
    </>
  );
}
