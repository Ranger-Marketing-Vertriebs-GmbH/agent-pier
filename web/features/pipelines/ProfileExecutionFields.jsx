import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { changeProfileAccount, permissionModes } from "./profile-draft.js";
import ProfileProviderFields from "./ProfileProviderFields.jsx";
import ProviderModelDetails from "../providers/ProviderModelDetails.jsx";
import ProviderCatalogStatus from "../providers/ProviderCatalogStatus.jsx";

// AUSFÜHRUNG: account, provider access, permissions, run mode and models.
export default function ProfileExecutionFields({
  draft,
  setDraft,
  patchConfig,
  accounts,
  account,
  connections,
  connection,
  catalog,
  busy,
}) {
  const config = draft.config;
  return (
    <fieldset className="profile-section">
      <legend className="profile-caps">{copy.profileSections.execution}</legend>
      <div className="profile-grid">
        <label>
          {copy.account}
          <AnchoredSelect
            label={copy.account}
            required
            value={config.accountId}
            disabled={busy}
            onChange={(value) =>
              setDraft(
                changeProfileAccount(
                  draft,
                  accounts.find((a) => a.id === value),
                ),
              )
            }
            options={[
              { value: "", label: copy.chooseAccount },
              ...accounts
                .filter((a) => a.tool !== "shell")
                .map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </label>
        <label>
          {copy.permissions}
          <AnchoredSelect
            label={copy.permissions}
            value={config.permissions.mode}
            disabled={busy}
            onChange={(value) => patchConfig({ permissions: { mode: value } })}
            options={(permissionModes[config.cliTool] || []).map((value) => ({
              value,
              label: value,
            }))}
          />
        </label>
      </div>
      <ProfileProviderFields
        config={config}
        patch={patchConfig}
        resource={connections}
        connection={connection}
        catalog={catalog}
      />
      <div className="profile-grid">
        <label>
          {copy.models}
          <textarea
            rows={3}
            value={config.models.available.join("\n")}
            onChange={(event) => {
              const available = event.target.value
                .split("\n")
                .map((value) => value.trim());
              patchConfig({
                models: {
                  available,
                  default: available.includes(config.models.default)
                    ? config.models.default
                    : available[0],
                },
              });
            }}
          />
        </label>
        {!config.providerConnectionId && (
          <label>
            {copy.model}
            <AnchoredSelect
              label={copy.model}
              value={config.models.default}
              disabled={busy}
              onChange={(value) =>
                patchConfig({ models: { ...config.models, default: value } })
              }
              options={[...new Set(config.models.available)].map((value) => ({
                value,
                label: value || copy.accountDefault,
              }))}
            />
          </label>
        )}
      </div>
      <p className="field-description">
        {config.providerConnectionId ? copy.centralModelsHelp : copy.modelsHelp}
      </p>
      {!config.providerConnectionId && account?.provider && (
        <details className="profile-saved-config">
          <summary>{copy.savedConfiguration}</summary>
          <ProviderCatalogStatus catalog={catalog} />
          <ProviderModelDetails
            model={catalog.models.find(
              (model) =>
                model.modelId === (config.models.default || account.provider.modelId),
            )}
            tool={config.cliTool}
          />
        </details>
      )}
      <label className="pipeline-check">
        <input
          type="checkbox"
          checked={config.run.autonomous}
          onChange={(event) => patchConfig({ run: { autonomous: event.target.checked } })}
        />
        {copy.autonomous}
      </label>
      <p className="field-description">{copy.pipelinePermissionsHint}</p>
    </fieldset>
  );
}
