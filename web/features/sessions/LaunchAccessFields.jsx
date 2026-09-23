import React, { useId } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ProviderModelPicker from "../providers/ProviderModelPicker.jsx";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import { launchDialogCopy as sandboxCopy } from "../../lib/i18n/messages/sessions.js";
export default function LaunchAccessFields({
  access,
  onAccessChange,
  taskProfileSelected = false,
}) {
  const modelHelpId = useId();
  const sandboxDisabled = !access.sandboxAvailable || taskProfileSelected;
  const sandboxFields = (
    <fieldset>
      <legend>{sandboxCopy.sandboxSection}</legend>
      <label>
        {sandboxCopy.sandboxProfile}
        <AnchoredSelect
          label={sandboxCopy.sandboxProfile}
          value={access.nonoProfile || ""}
          disabled={sandboxDisabled}
          onChange={(value) => access.setNonoProfile(value || null)}
          options={[
            { value: "", label: sandboxCopy.noSandboxProfile },
            ...access.sandboxProfiles.map((name) => ({ value: name, label: name })),
          ]}
        />
      </label>
      {!access.sandboxAvailable ? (
        <p className="field-description">{sandboxCopy.sandboxUnavailable}</p>
      ) : taskProfileSelected ? (
        <p className="field-description">
          {sandboxCopy.sandboxUnavailableForTaskProfile}
        </p>
      ) : (
        access.nonoProfile && (
          <p className="field-description">{sandboxCopy.sandboxHint}</p>
        )
      )}
    </fieldset>
  );
  if (access.tool === "shell") return sandboxFields;
  return (
    <>
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
      {sandboxFields}
    </>
  );
}
