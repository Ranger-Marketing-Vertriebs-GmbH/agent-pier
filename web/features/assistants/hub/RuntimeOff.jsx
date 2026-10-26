import React from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { operationsCopy } from "../../../lib/i18n/messages/operations.js";
import { settingsPageCopy } from "../../../lib/i18n/messages/settings.js";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { featureStep } from "../../settings/settings-steps.js";
import HubFrame from "./HubFrame.jsx";
import RuntimeFeatureGroup from "./RuntimeFeatureGroup.jsx";

// The draft stays for navigations within the Runtime tab (`section=advanced` too).
const staysOnRuntime = (request) => {
  const next = request?.next;
  return (
    next?.view === "agents" &&
    next.agentsTab === "runtime" &&
    !next.assistantId &&
    !next.creating
  );
};

export function useRuntimeGuard(draft, save) {
  return useUnsavedChangesGuard({
    draft,
    tab: copy.tabs.runtime,
    save,
    stays: staysOnRuntime,
  });
}

/** Runtime while agents are off: only the switch, saved through the same step. */
export default function RuntimeOff({ frame, feature }) {
  const draft = useTabDraft({ server: { agentsEnabled: feature.enabled } });
  const steps = [
    featureStep({
      label: () => operationsCopy.sections.assistants,
      setEnabled: feature.setEnabled,
      notApplied: () => settingsPageCopy.agentsNotApplied,
    }),
  ];
  const save = () => draft.save(steps);
  const sheet = useRuntimeGuard(draft, save);
  return (
    <HubFrame
      {...frame}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={settingsPageCopy.saveSettings}
        />
      }
    >
      <p className="field-description">{copy.runtime.lead}</p>
      <RuntimeFeatureGroup draft={draft} feature={feature} />
      <p className="field-description">{copy.runtime.serviceOff}</p>
      <UnsavedChangesSheet {...sheet} />
    </HubFrame>
  );
}
