import React, { useId } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ProviderModelPicker from "../providers/ProviderModelPicker.jsx";
import { names } from "../../lib/providers.js";
import { connectionCopy as copy } from "../../lib/i18n/de/connections.js";
export default function LaunchAccessFields({ access, onToolChange, onAccessChange }) {
  const modelHelpId = useId();
  if (access.tool === "shell") return null;
  return (
    <>
      <label>
        {copy.cli}
        <AnchoredSelect
          label={copy.cli}
          value={access.tool}
          required
          onChange={onToolChange}
          options={access.tools.map((tool) => ({
            value: tool.id,
            label: names[tool.id] || tool.name,
          }))}
        />
      </label>
      <label>
        {copy.access}
        <AnchoredSelect
          label={copy.access}
          value={access.accessId}
          required
          onChange={onAccessChange}
          options={[
            ...access.accounts.map((account) => ({
              value: account.id,
              label: account.name + (account.provider ? ` · ${copy.legacy}` : ""),
            })),
            ...access.connections.map((connection) => ({
              value: `provider:${connection.id}`,
              label: `${connection.name} · ${copy.providerNames[connection.providerId] || connection.providerId}${connection.hasSecret ? "" : ` · ${copy.keyMissing}`}`,
              disabled: !connection.hasSecret,
            })),
            ...(!access.accounts.length && !access.connections.length
              ? [{ value: "", label: copy.noAccess }]
              : []),
          ]}
        />
      </label>
      {access.connection ? (
        <>
          <p className="field-description">{copy.isolated}</p>
          <ProviderModelPicker
            catalog={access.catalog}
            tool={access.tool}
            modelId={access.modelId}
            setModel={access.setModel}
            query={access.query}
            setQuery={access.setQuery}
          />
        </>
      ) : access.account?.provider ? (
        <p className="field-description">{copy.legacyLaunch}</p>
      ) : (
        <label>
          {copy.nativeModel}
          <input
            aria-label={copy.nativeModel}
            aria-describedby={modelHelpId}
            value={access.nativeModelId}
            onChange={(event) => access.setNativeModel(event.target.value)}
            maxLength={160}
            placeholder={copy.nativeDefault}
          />
          <small id={modelHelpId} className="field-description">
            {copy.nativeModelHelp}
          </small>
        </label>
      )}
    </>
  );
}
