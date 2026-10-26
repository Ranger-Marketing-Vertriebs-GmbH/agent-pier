import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, {
  SelectRow,
  ToggleRow,
  unknownValue,
} from "../../components/ListRow.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { routePath } from "../../app/routes.js";
import { setLanguage } from "../../lib/i18n/index.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { mcpDirectoryCopy } from "../../lib/i18n/messages/mcp-directory.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy, settingsPageCopy } from "../../lib/i18n/messages/settings.js";
import { sameValue } from "../../lib/settings/draft-state.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import { agentsHubRoute } from "../assistants/hub-routes.js";
import { agentsHubCopy as hubCopy } from "../../lib/i18n/messages/agents-hub.js";
import DirectoryRow from "./DirectoryRow.jsx";
import McpDirectoryRow, { officialRegistry } from "./McpDirectoryRow.jsx";
import { TabFrame } from "./SettingsFrame.jsx";
import { MovedGroup } from "./SummaryTabs.jsx";
import { staysOn } from "./settings-navigation.js";
import { fieldCheckStep, languageStep, preferencesStep } from "./settings-steps.js";
// Agents are switched on and off under Agenten › Laufzeit (handoff 5.2).
const agentsRuntime = agentsHubRoute("runtime");

// Language names are endonyms, the same in every UI language.
const languages = [
  { value: "de", label: "Deutsch", lang: "de" },
  { value: "en", label: "English", lang: "en" },
];
const stays = staysOn("general", "general");

export default function WorkspaceTab({ frame, state, refresh, ready }) {
  const language = useLanguage();
  const feature = useAssistantFeature();
  const server = {
    language,
    defaultCwd: ready ? state.defaultCwd || state.home || "" : "",
    autoResumeInterrupted: state.autoResumeInterrupted !== false,
    mcpDirectoryEnabled: state.mcpDirectory?.enabled !== false,
    mcpDirectoryBaseUrl: state.mcpDirectory?.baseUrl || officialRegistry,
  };
  const draft = useTabDraft({ server });
  const [saved, setSaved] = useState(false);
  // The state refresh of the preferences step (or the 3s state poll) can publish the
  // server's canonical directory (realpath, "~/work") while the save is still running;
  // useTabDraft then records a conflict and, once the save marks the typed value as
  // base, never revisits the server. A clean tab always shows the server's values.
  useEffect(() => {
    if (!draft.dirty && !draft.saving && !sameValue(draft.values, server)) draft.reset();
  });
  const directoryError = (values) =>
    String(values.defaultCwd ?? "").trim() ? "" : settingsPageCopy.directoryRequired;
  // Labels are read when the bar reports a partial save, after a language switch.
  const steps = [
    // Checked before the language step, so an empty directory saves nothing.
    fieldCheckStep({ id: "directory", fields: ["defaultCwd"], error: directoryError }),
    languageStep({ label: () => commonCopy.language, apply: setLanguage }),
    preferencesStep({ label: () => operationsCopy.sections.general, refresh }),
  ];
  const finish = (result) => {
    setSaved(result.status === "saved");
    return result;
  };
  const save = async () => finish(await draft.save(steps));
  const overwrite = async () => finish(await draft.overwrite(steps));
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: operationsCopy.groups.general,
    save,
    stays,
  });
  const edit = (key) => (value) => {
    setSaved(false);
    draft.set(key, value);
  };
  const locked = !ready || draft.saving;
  const fieldError =
    ready && draft.changedKeys.includes("defaultCwd") ? directoryError(draft.values) : "";
  // A refused registry address is named at its field, not in the bar, while the
  // field still holds a changed address.
  const addressRefused =
    draft.outcome?.status === "error" &&
    draft.outcome.error?.messageKey === "mcpDirectory.invalidSettings";
  const addressError =
    addressRefused && draft.changedKeys.includes("mcpDirectoryBaseUrl")
      ? mcpDirectoryCopy.baseUrlInvalid
      : "";
  const bar = addressRefused
    ? { ...draft, outcome: { ...draft.outcome, error: undefined } }
    : draft;
  return (
    <TabFrame
      frame={frame}
      bar={
        <SaveBar
          draft={bar}
          onSave={save}
          onOverwrite={overwrite}
          saveLabel={settingsPageCopy.saveSettings}
        />
      }
    >
      {!ready && <p role="status">{settingsPageCopy.loadingSettings}</p>}
      <GroupLabel id="settings-general">{operationsCopy.sections.general}</GroupLabel>
      <ListCard labelledBy="settings-general">
        <SelectRow
          label={commonCopy.language}
          value={draft.values.language}
          options={languages}
          disabled={draft.saving}
          onChange={edit("language")}
        />
        <DirectoryRow
          value={draft.values.defaultCwd}
          home={state.home}
          disabled={locked}
          onChange={edit("defaultCwd")}
        />
        <ToggleRow
          label={settingsPageCopy.autoResumeLabel}
          hint={settingsPageCopy.autoResumeDescription}
          checked={draft.values.autoResumeInterrupted}
          disabled={locked}
          onChange={edit("autoResumeInterrupted")}
        />
      </ListCard>
      <ErrorMessage error={fieldError} />
      {/* Funktionen: the one link to the agents switch on Agenten › Laufzeit. */}
      <GroupLabel id="settings-features">{settingsHubCopy.featuresGroup}</GroupLabel>
      <ListCard labelledBy="settings-features">
        <ListRow
          label={assistantCopy.title}
          sub={settingsHubCopy.featureAgentsSub}
          status={
            feature.enabled && !feature.loading
              ? { tone: "ok", text: hubCopy.featureOn }
              : undefined
          }
          value={
            feature.loading
              ? unknownValue
              : feature.enabled
                ? undefined
                : hubCopy.featureOff
          }
          href={routePath(agentsRuntime)}
          onClick={() => frame.go(agentsRuntime)}
        />
      </ListCard>
      <McpDirectoryRow
        values={draft.values}
        edit={edit}
        error={addressError}
        disabled={locked}
      />
      <MovedGroup frame={frame} />
      {saved && !draft.dirty && (
        <p className="field-description" role="status">
          {settingsPageCopy.settingsSaved}
        </p>
      )}
      <UnsavedChangesSheet {...sheet} />
    </TabFrame>
  );
}
