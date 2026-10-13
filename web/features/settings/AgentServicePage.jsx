import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { NumberRow } from "../../components/ListRow.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantTeamCopy as teamCopy } from "../../lib/i18n/messages/assistant-team.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import AssistantRuntimeSettings from "../assistants/AssistantRuntimeSettings.jsx";
import { assistantApi } from "../assistants/assistant-api.js";
import useAssistants from "../assistants/useAssistants.js";
import { SubpageFrame } from "./SettingsFrame.jsx";
import { staysOn } from "./settings-navigation.js";
import {
  capacityInvalid,
  capacityRange,
  fieldCheckStep,
  hostCapacityStep,
} from "./settings-steps.js";

const stays = staysOn("assistants");

// Runtime, runtime updates (immediate actions) and the host team capacity (a draft).
export default function AgentServicePage({ frame, diagnostic }) {
  const { teamSettings, refresh } = useAssistants();
  const draft = useTabDraft({
    server: { hostMaxConcurrent: teamSettings?.hostMaxConcurrent ?? "" },
    revisions: { team: teamSettings?.revision },
    // A missed change event would leave Reload and Overwrite on stale props.
    refresh: async () => {
      const { teamSettings: fresh } = await assistantApi.list();
      refresh();
      return {
        server: { hostMaxConcurrent: fresh?.hostMaxConcurrent ?? "" },
        revisions: { team: fresh?.revision },
      };
    },
  });
  const rangeError = (values) =>
    capacityInvalid(values.hostMaxConcurrent)
      ? teamCopy.capacityRange(capacityRange.min, capacityRange.max)
      : "";
  const fieldError = draft.changedKeys.includes("hostMaxConcurrent")
    ? rangeError(draft.values)
    : "";
  const steps = [
    fieldCheckStep({
      id: "capacityRange",
      fields: ["hostMaxConcurrent"],
      error: rangeError,
    }),
    hostCapacityStep({
      label: () => teamCopy.settings,
      save: assistantApi.teamSettings,
      refresh,
    }),
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: assistantCopy.runtime,
    save,
    stays,
  });
  return (
    <SubpageFrame
      frame={frame}
      title={assistantCopy.runtime}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={teamCopy.save}
        />
      }
    >
      <ErrorMessage error={diagnostic} />
      <AssistantRuntimeSettings />
      <GroupLabel id="agent-service-team" hint={teamCopy.concurrentHint}>
        {teamCopy.settings}
      </GroupLabel>
      <ListCard labelledBy="agent-service-team">
        <NumberRow
          label={teamCopy.capacity}
          value={draft.values.hostMaxConcurrent}
          min={capacityRange.min}
          max={capacityRange.max}
          disabled={!teamSettings || draft.saving}
          onChange={(value) => draft.set("hostMaxConcurrent", value)}
        />
      </ListCard>
      <ErrorMessage error={fieldError} />
      <UnsavedChangesSheet {...sheet} />
    </SubpageFrame>
  );
}
