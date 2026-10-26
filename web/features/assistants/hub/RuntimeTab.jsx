import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { NumberRow } from "../../../components/ListRow.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantAdvancedCopy } from "../../../lib/i18n/messages/assistant-advanced.js";
import { assistantTeamCopy as teamCopy } from "../../../lib/i18n/messages/assistant-team.js";
import { settingsPageCopy } from "../../../lib/i18n/messages/settings.js";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { CleanupGroup } from "../../dashboard/StorageCleanup.jsx";
import CleanupDependencies from "../../dashboard/CleanupDependencies.jsx";
import DreamingGroup, { DreamingConfirmation } from "../../settings/DreamingGroup.jsx";
import { capacityRange } from "../../settings/settings-steps.js";
import { assistantApi } from "../assistant-api.js";
import AssistantRuntimeUpdates from "../AssistantRuntimeUpdates.jsx";
import RestartConfirmation from "../RestartConfirmation.jsx";
import useAssistants from "../useAssistants.js";
import useDreaming from "../useDreaming.js";
import HubFrame from "./HubFrame.jsx";
import RuntimeAdvancedGroup from "./RuntimeAdvancedGroup.jsx";
import RuntimeFeatureGroup from "./RuntimeFeatureGroup.jsx";
import RuntimeServiceGroup from "./RuntimeServiceGroup.jsx";
import {
  advancedKey,
  advancedRangeError,
  capacityError,
  runtimeServer,
  runtimeSteps,
} from "./runtime-draft.js";
import "../../dashboard/storage-cleanup.css";

import { useRuntimeGuard } from "./RuntimeOff.jsx";

// The groups a `section=` link scrolls to.
const sectionIds = {
  advanced: "agents-runtime-advanced",
  storage: "agents-runtime-storage",
};

function useAdvancedSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async (signal) => {
    try {
      const next = await assistantApi.advancedSettings(signal);
      setData(next);
      setError("");
      return next;
    } catch (e) {
      if (e?.name !== "AbortError") setError(assistantAdvancedCopy.loadFailed);
      return null;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  // A setting this build has no texts for (a newer server) is left out.
  const settings = useMemo(
    () => (data?.settings || []).filter((s) => assistantAdvancedCopy.settings[s.id]),
    [data],
  );
  return { data, setData, settings, error, load };
}

/**
 * Laufzeit (handoff 5.2): everything of the former Agentendienst page and its
 * Erweitert subpage in one draft. Real actions (service, updates, cleanup) stay
 * immediate; the save bar keeps the existing server calls, each with its revision.
 */
export function RuntimeOn({ frame, feature, section }) {
  const { teamSettings, refresh } = useAssistants();
  const { dreaming, error: dreamingError, refresh: refreshDreaming } = useDreaming();
  const advanced = useAdvancedSettings();
  const draft = useTabDraft({
    server: runtimeServer({
      enabled: feature.enabled,
      teamSettings,
      dreaming,
      advanced: advanced.data,
    }),
    revisions: { team: teamSettings?.revision, dreaming: dreaming?.revision },
    // A missed change event would leave Reload and Overwrite on stale props.
    refresh: async () => {
      const [{ teamSettings: fresh }, freshDreaming, freshAdvanced] = await Promise.all([
        assistantApi.list(),
        assistantApi.dreaming(),
        advanced.load(),
      ]);
      refresh();
      refreshDreaming().catch(() => {});
      return {
        server: runtimeServer({
          enabled: feature.enabled,
          teamSettings: fresh,
          dreaming: freshDreaming,
          advanced: freshAdvanced,
        }),
        revisions: { team: fresh?.revision, dreaming: freshDreaming?.revision },
      };
    },
  });
  const steps = runtimeSteps({
    api: assistantApi,
    setEnabled: feature.setEnabled,
    refresh: { assistants: refresh, dreaming: refreshDreaming },
    settings: advanced.settings,
    onAdvanced: advanced.setData,
  });
  const save = () => draft.save(steps);
  const sheet = useRuntimeGuard(draft, save);
  // Any change withdraws an open restart question; it was about the previous state.
  const edit = (key) => (value) => {
    if (draft.confirmation?.kind === "restart") draft.confirmation.cancel();
    draft.set(key, value);
  };
  const changed = (key) => draft.changedKeys.includes(key);
  const fieldError =
    (changed("hostMaxConcurrent") && capacityError(draft.values)) ||
    advanced.settings
      .map((s) =>
        changed(advancedKey(s.id))
          ? advancedRangeError(s, draft.values[advancedKey(s.id)])
          : "",
      )
      .find(Boolean) ||
    "";
  const restart = draft.confirmation?.kind === "restart" ? draft.confirmation : null;
  // `section=advanced|storage` scrolls to the group once the advanced values above
  // it have loaded (or failed), once per link.
  const scrolled = useRef(false);
  const advancedSettled = Boolean(advanced.data || advanced.error);
  useEffect(() => {
    if (!sectionIds[section]) {
      scrolled.current = false;
      return;
    }
    if (scrolled.current || !advancedSettled) return;
    scrolled.current = true;
    document
      .getElementById(sectionIds[section])
      ?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [section, advancedSettled]);
  const teamId = useId();
  // Only the host capacity changed: the bar names the team settings, as before.
  const teamOnly =
    draft.changedKeys.length > 0 &&
    draft.changedKeys.every((key) => key === "hostMaxConcurrent");
  return (
    <HubFrame
      {...frame}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={teamOnly ? teamCopy.save : settingsPageCopy.saveSettings}
        />
      }
    >
      <p className="field-description">{copy.runtime.lead}</p>
      <ErrorMessage error={dreamingError} />
      <RuntimeFeatureGroup draft={draft} feature={feature} />
      <RuntimeServiceGroup />
      <AssistantRuntimeUpdates onChange={refresh} />
      <section aria-labelledby={teamId}>
        <GroupLabel id={teamId} hint={teamCopy.concurrentHint}>
          {copy.runtime.teams}
        </GroupLabel>
        <ListCard labelledBy={teamId}>
          <NumberRow
            label={teamCopy.capacity}
            value={draft.values.hostMaxConcurrent ?? ""}
            min={capacityRange.min}
            max={capacityRange.max}
            disabled={!teamSettings || draft.saving}
            onChange={edit("hostMaxConcurrent")}
          />
        </ListCard>
      </section>
      <DreamingGroup
        values={draft.values}
        set={draft.set}
        disabled={!dreaming || draft.saving}
        savedZone={draft.base.dreamingTimeZone}
      />
      <RuntimeAdvancedGroup
        data={advanced.data}
        settings={advanced.settings}
        loadError={advanced.error}
        values={draft.values}
        edit={edit}
        disabled={draft.saving}
      />
      <ErrorMessage error={fieldError} />
      <section id={sectionIds.storage} aria-labelledby={`${teamId}-storage`}>
        <GroupLabel id={`${teamId}-storage`}>{copy.runtime.storage}</GroupLabel>
        <CleanupGroup id="dependencies" List={CleanupDependencies} />
      </section>
      {restart && (
        <RestartConfirmation
          affected={restart.data?.affected}
          busy={false}
          onConfirm={restart.confirm}
          onCancel={restart.cancel}
        />
      )}
      <DreamingConfirmation confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </HubFrame>
  );
}
