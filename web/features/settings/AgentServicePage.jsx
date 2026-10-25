import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { NumberRow } from "../../components/ListRow.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { routePath } from "../../app/routes.js";
import { assistantAdvancedCopy } from "../../lib/i18n/messages/assistant-advanced.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantTeamCopy as teamCopy } from "../../lib/i18n/messages/assistant-team.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import AssistantRuntimeSettings from "../assistants/AssistantRuntimeSettings.jsx";
import { assistantApi } from "../assistants/assistant-api.js";
import useAssistants from "../assistants/useAssistants.js";
import useDreaming from "../assistants/useDreaming.js";
import { assistantDreamingCopy as dreamingCopy } from "../../lib/i18n/messages/assistant-dreaming.js";
import DreamingGroup, { DreamingConfirmation } from "./DreamingGroup.jsx";
import { SubpageFrame } from "./SettingsFrame.jsx";
import { staysOn, subpage } from "./settings-navigation.js";
import {
  capacityInvalid,
  capacityRange,
  dreamingStep,
  fieldCheckStep,
  hostCapacityStep,
} from "./settings-steps.js";

const stays = staysOn("assistants");
const dreamingKeys = ["dreamingEnabled", "dreamingHour", "dreamingTimeZone"];
const dreamingServer = (dreaming) => ({
  dreamingEnabled: dreaming?.enabled === true,
  dreamingHour: dreaming?.hour ?? 3,
  dreamingTimeZone: dreaming?.timeZone ?? "UTC",
});

// Runtime, runtime updates (immediate actions), and the host team capacity and
// dreaming (one draft).
export default function AgentServicePage({ frame, diagnostic }) {
  const { teamSettings, refresh } = useAssistants();
  const { dreaming, error: dreamingError, refresh: refreshDreaming } = useDreaming();
  const draft = useTabDraft({
    server: {
      hostMaxConcurrent: teamSettings?.hostMaxConcurrent ?? "",
      ...dreamingServer(dreaming),
    },
    revisions: { team: teamSettings?.revision, dreaming: dreaming?.revision },
    // A missed change event would leave Reload and Overwrite on stale props.
    refresh: async () => {
      const [{ teamSettings: fresh }, freshDreaming] = await Promise.all([
        assistantApi.list(),
        assistantApi.dreaming(),
      ]);
      refresh();
      refreshDreaming().catch(() => {});
      return {
        server: {
          hostMaxConcurrent: fresh?.hostMaxConcurrent ?? "",
          ...dreamingServer(freshDreaming),
        },
        revisions: { team: fresh?.revision, dreaming: freshDreaming?.revision },
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
    dreamingStep({
      label: () => dreamingCopy.title,
      save: assistantApi.saveDreaming,
      // Memory switched on for agents shows on their Capabilities tab.
      refresh: () => Promise.all([refreshDreaming(), refresh()]),
    }),
  ];
  // The team label only while nothing else of the draft changed.
  const dreamingChanged = draft.changedKeys.some((key) => dreamingKeys.includes(key));
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
          saveLabel={dreamingChanged ? undefined : teamCopy.save}
        />
      }
    >
      <ErrorMessage error={diagnostic} />
      <ErrorMessage error={dreamingError} />
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
      <DreamingGroup
        values={draft.values}
        set={draft.set}
        disabled={!dreaming || draft.saving}
        savedZone={draft.base.dreamingTimeZone}
      />
      <GroupLabel id="agent-service-advanced">{assistantAdvancedCopy.title}</GroupLabel>
      <ListCard labelledBy="agent-service-advanced">
        <ListRow
          label={assistantAdvancedCopy.entry}
          sub={assistantAdvancedCopy.entrySub}
          href={routePath(subpage("assistants-advanced"))}
          onClick={() => frame.go(subpage("assistants-advanced"))}
        />
      </ListCard>
      <DreamingConfirmation confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </SubpageFrame>
  );
}
