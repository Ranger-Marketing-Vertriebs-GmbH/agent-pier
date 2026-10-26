import React from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { hookCopy } from "../../../lib/i18n/messages/assistant-hooks.js";
import { assistantProactivityCopy as proactivity } from "../../../lib/i18n/messages/assistant-proactivity.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import useAssistants from "../useAssistants.js";
import HookPage from "./HookPage.jsx";
import HooksGroup from "./HooksGroup.jsx";
import RemindersGroup from "./RemindersGroup.jsx";
import RoutinesGroup from "./RoutinesGroup.jsx";
import { routinesServer } from "./agent-settings-fields.js";
import { heartbeatStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useTelegramChannel from "./useTelegramChannel.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProactivityGroup from "./ProactivityGroup.jsx";

const conflictLabels = {
  heartbeatEnabled: () => proactivity.heartbeat,
  interval: () => proactivity.interval,
  start: () => proactivity.activeFrom,
  end: () => proactivity.activeUntil,
  timeZone: () => proactivity.title,
  heartbeatTelegram: () => proactivity.alsoTelegram,
};

/**
 * Automatisierung (former Routines & check-ins): everything the agent does on its own. Results go to the
 * agent's chat with a push notification; with a paired Telegram chat each item can
 * go there too. Check-ins are the tab's draft; reminders, routines and hooks apply at
 * once. A hook's detail (`page === "hook"`) is a subpage with its own draft.
 */
export default function AutomationTab({ assistant, page, go, navigate, hookId }) {
  const { refresh } = useAssistants();
  const { channel } = useTelegramChannel(assistant.id);
  const paired = Boolean(channel?.enabled && channel?.chatId);
  const draft = useTabDraft({
    server: routinesServer(assistant),
    revisions: { assistant: assistant.revision },
  });
  const label = settingsCopy.tabs.automation;
  const steps = [heartbeatStep({ assistant, label: proactivity.title })];
  const after = async (result) => {
    if (result.completed?.length) await refresh();
    return result;
  };
  const save = async () => after(await draft.save(steps));
  const back = () => go("automation");
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "automation",
    label,
    save,
  });
  if (page === "hook")
    return (
      <>
        <HookPage assistant={assistant} hookId={hookId} onBack={back} />
        <UnsavedChangesSheet {...sheet} />
      </>
    );
  const shared = assistant.userAccess?.mode === "shared";
  return (
    <section id="agent-routines-tab">
      <ConflictNotice draft={draft} labels={conflictLabels} />
      <ProactivityGroup
        assistant={assistant}
        values={draft.values}
        set={draft.set}
        paired={paired}
      />
      {assistant.userAccess?.mode === "own" ? (
        // Her reminders and routines carry what she asked for: hers to manage.
        <>
          <p className="assistant-note">
            {assistant.userAccess.members[0]?.level === "chat"
              ? usersCopy.ownRoutinesChatOnly
              : usersCopy.ownRoutines}
          </p>
          <p className="assistant-note">{hookCopy.shared}</p>
        </>
      ) : (
        <>
          {assistant.capabilities?.reminders ? (
            <>
              <RemindersGroup assistantId={assistant.id} paired={paired} />
              <RoutinesGroup assistantId={assistant.id} paired={paired} />
            </>
          ) : (
            <p className="assistant-note">{settingsCopy.remindersNeedCapability}</p>
          )}
          {shared ? (
            <p className="assistant-note">{hookCopy.shared}</p>
          ) : (
            <HooksGroup
              assistantId={assistant.id}
              paused={!assistant.capabilities?.reminders}
              navigate={navigate}
            />
          )}
        </>
      )}
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        saveLabel={assistantCopy.save}
        note={assistantCopy.pendingConfigShort}
      />
      <ConfirmationSheet confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </section>
  );
}
