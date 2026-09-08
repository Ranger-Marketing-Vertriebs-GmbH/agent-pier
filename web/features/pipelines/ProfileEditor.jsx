import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
import ParameterFields from "./ParameterFields.jsx";
import {
  blankProfile,
  changeProfileAccount,
  permissionModes,
  profileBody,
} from "./profile-draft.js";
import useResource from "../../lib/useResource.js";
import ProfileProviderFields from "./ProfileProviderFields.jsx";
import useProviderCatalog from "../providers/useProviderCatalog.js";
import ProviderModelDetails from "../providers/ProviderModelDetails.jsx";
import ProviderCatalogStatus from "../providers/ProviderCatalogStatus.jsx";
export default function ProfileEditor({ profile, accounts, close, saved, stats }) {
  const [draft, setDraft] = useState(() =>
    structuredClone(profile || blankProfile(accounts.find((a) => a.tool !== "shell"))),
  );
  const action = useAsyncAction();
  const config = draft.config;
  const account = accounts.find((a) => a.id === config.accountId);
  const connections = useResource("/provider-connections");
  const connection = connections.data?.connections?.find(
    (item) =>
      item.id === config.providerConnectionId && item.tools.includes(config.cliTool),
  );
  const catalog = useProviderCatalog(
    connection?.providerId ||
      (!config.providerConnectionId && account?.provider?.id) ||
      "",
    config.cliTool,
  );
  const centralReady =
    !config.providerConnectionId ||
    Boolean(
      connection &&
      !catalog.loading &&
      config.models.available.every((id) =>
        catalog.models.some((model) => model.modelId === id),
      ) &&
      config.models.available.includes(config.models.default),
    );
  const patch = (change) => setDraft((current) => ({ ...current, ...change }));
  const patchConfig = (change) => patch({ config: { ...config, ...change } });
  const dismiss = () => {
    if (!action.lock.current) close();
  };
  return (
    <Modal
      title={profile?.id ? copy.edit(profile.name) : copy.newProfile}
      close={dismiss}
      closeDisabled={action.busy}
      wide
    >
      <form
        className="pipeline-form"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            const result = await api(
              `/pipeline-profiles${profile?.id ? "/" + encodeURIComponent(profile.id) : ""}`,
              profile?.id ? "PATCH" : "POST",
              {
                ...profileBody(draft),
                ...(profile?.id ? { expectedRevision: profile.revision } : {}),
              },
            );
            saved(result.profile);
          });
        }}
      >
        {stats && <p>{copy.stageRuns(stats.stageRunsLast7Days)}</p>}
        <fieldset disabled={action.busy}>
          <label>
            {copy.profileName}
            <input
              required
              maxLength={100}
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>
          <label>
            {copy.descriptionLabel}
            <textarea
              rows={2}
              value={draft.description || ""}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </label>
          <label className="pipeline-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            {copy.enabled}
          </label>
          <label>
            {copy.phase}
            <AnchoredSelect
              label={copy.phase}
              value={draft.phaseKey || "custom"}
              disabled={action.busy}
              onChange={(value) => patch({ phaseKey: value })}
              options={Object.entries(copy.phaseNames).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </label>
          <label>
            {copy.account}
            <AnchoredSelect
              label={copy.account}
              required
              value={config.accountId}
              disabled={action.busy}
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
          <ProfileProviderFields
            config={config}
            patch={patchConfig}
            resource={connections}
            connection={connection}
            catalog={catalog}
          />
          <label>
            {copy.permissions}
            <AnchoredSelect
              label={copy.permissions}
              value={config.permissions.mode}
              disabled={action.busy}
              onChange={(value) => patchConfig({ permissions: { mode: value } })}
              options={(permissionModes[config.cliTool] || []).map((value) => ({
                value,
                label: value,
              }))}
            />
          </label>
          <label className="pipeline-check">
            <input
              type="checkbox"
              checked={config.run.autonomous}
              onChange={(event) =>
                patchConfig({ run: { autonomous: event.target.checked } })
              }
            />
            {copy.autonomous}
          </label>
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
          <p className="field-description">
            {config.providerConnectionId ? copy.centralModelsHelp : copy.modelsHelp}
          </p>
          {!config.providerConnectionId && (
            <label>
              {copy.model}
              <AnchoredSelect
                label={copy.model}
                value={config.models.default}
                disabled={action.busy}
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
          {!config.providerConnectionId && account?.provider && (
            <details>
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
          <label>
            {copy.role}
            <textarea
              rows={4}
              value={config.prompts.role}
              onChange={(event) =>
                patchConfig({ prompts: { ...config.prompts, role: event.target.value } })
              }
            />
          </label>
          <label>
            {copy.kickoff}
            <textarea
              rows={4}
              required={config.run.autonomous}
              value={config.prompts.kickoff}
              onChange={(event) =>
                patchConfig({
                  prompts: { ...config.prompts, kickoff: event.target.value },
                })
              }
            />
          </label>
          <ParameterFields
            params={config.prompts.params}
            onChange={(params) => patchConfig({ prompts: { ...config.prompts, params } })}
          />
          {(!config.run.autonomous || config.prompts.params.some((p) => p.required)) && (
            <p className="field-description">{copy.profileEligibility}</p>
          )}
        </fieldset>
        <ErrorMessage error={action.error} />
        <div className="pipeline-actions">
          <button
            type="button"
            className="button secondary"
            onClick={dismiss}
            disabled={action.busy}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy || !centralReady}>
            {commonCopy.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
