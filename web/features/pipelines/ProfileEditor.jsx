import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import ParameterFields from "./ParameterFields.jsx";
import { blankProfile, profileBody } from "./profile-draft.js";
import useResource from "../../lib/useResource.js";
import ProfileExecutionFields from "./ProfileExecutionFields.jsx";
import useProviderCatalog from "../providers/useProviderCatalog.js";

const phaseLabel = (profile) =>
  copy.phaseNames[profile.phaseKey || "custom"] || copy.phaseNames.custom;

// Title, run statistics and the actions that act on the saved profile.
function ProfileHead({
  profile,
  stats,
  headingId,
  eligible,
  onLaunch,
  onDuplicate,
  onRemove,
}) {
  return (
    <header className="profile-head">
      <div className="profile-head-title">
        <h2 id={headingId}>{profile?.id ? profile.name : copy.newProfile}</h2>
        {profile?.id && (
          <span>
            {phaseLabel(profile)}
            {stats ? ` · ${copy.stageRuns(stats.stageRunsLast7Days)}` : ""}
          </span>
        )}
      </div>
      {profile?.id && (
        <div className="profile-head-actions">
          <button
            type="button"
            className="button primary"
            disabled={!profile.enabled}
            onClick={onLaunch}
          >
            {copy.startProfile}
          </button>
          <button
            type="button"
            className="button secondary"
            aria-label={copy.clone(profile.name)}
            onClick={onDuplicate}
          >
            {copy.duplicate}
          </button>
          <button
            type="button"
            className="button secondary"
            aria-label={copy.remove(profile.name)}
            onClick={onRemove}
          >
            {commonCopy.delete}
          </button>
        </div>
      )}
      {!eligible && <p className="profile-eligibility">{copy.profileEligibility}</p>}
    </header>
  );
}

export default function ProfileEditor({
  profile,
  accounts,
  cancel,
  saved,
  stats,
  onLaunch,
  onDuplicate,
  onRemove,
  onDirtyChange,
}) {
  const [draft, setDraft] = useState(() =>
    structuredClone(profile || blankProfile(accounts.find((a) => a.tool !== "shell"))),
  );
  const [baseline] = useState(() => JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== baseline;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const headingId = useId();
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
  const eligible =
    config.run.autonomous && !config.prompts.params.some((p) => p.required);
  return (
    <form
      className="pipeline-form profile-card"
      aria-labelledby={headingId}
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
      <ProfileHead
        {...{ profile, stats, headingId, eligible, onLaunch, onDuplicate, onRemove }}
      />
      <fieldset disabled={action.busy}>
        <fieldset className="profile-section">
          <legend className="profile-caps">{copy.profileSections.basics}</legend>
          <div className="profile-grid">
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
          </div>
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
        </fieldset>
        <ProfileExecutionFields
          {...{ draft, setDraft, patchConfig, accounts, account, connection, catalog }}
          connections={connections}
          busy={action.busy}
        />
        <fieldset className="profile-section">
          <legend className="profile-caps">{copy.profileSections.instructions}</legend>
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
        </fieldset>
        <ParameterFields
          params={config.prompts.params}
          onChange={(params) => patchConfig({ prompts: { ...config.prompts, params } })}
        />
      </fieldset>
      <ErrorMessage error={action.error} />
      <div className="profile-footer">
        <button
          type="button"
          className="button secondary"
          onClick={cancel}
          disabled={action.busy}
        >
          {commonCopy.cancel}
        </button>
        <button className="button primary" disabled={action.busy || !centralReady}>
          {commonCopy.save}
        </button>
      </div>
    </form>
  );
}
