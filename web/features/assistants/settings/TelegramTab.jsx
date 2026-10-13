import React, { useEffect } from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantProactivityCopy as proactivity } from "../../../lib/i18n/messages/assistant-proactivity.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import RemindersGroup from "./RemindersGroup.jsx";
import RoutinesGroup from "./RoutinesGroup.jsx";
import { agentRoute, telegramServer } from "./agent-settings-fields.js";
import { channelStep, heartbeatStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useTelegramChannel from "./useTelegramChannel.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProactivityGroup from "./ProactivityGroup.jsx";
import { ConnectionGroup } from "./TelegramConnection.jsx";
import TelegramConnectionPage from "./TelegramConnectionPage.jsx";
import TelegramActivityPage from "./TelegramActivityPage.jsx";

const channelCopy = assistantCopy.channel;
const conflictLabels = {
  heartbeatEnabled: () => proactivity.heartbeat,
  interval: () => proactivity.interval,
  start: () => proactivity.activeFrom,
  end: () => proactivity.activeUntil,
  timeZone: () => proactivity.title,
  language: () => channelCopy.language,
  appUrl: () => channelCopy.appUrl,
};

/** Telegram: connection, check-ins, reminders and routines; heartbeat then channel save. */
export default function TelegramTab({ assistant, page, go, navigate }) {
  const { refresh } = useAssistants();
  const telegram = useTelegramChannel(assistant.id);
  const { channel } = telegram;
  const connected = Boolean(channel?.hasSecret);
  const draft = useTabDraft({
    server: telegramServer(assistant, channel),
    revisions: { assistant: assistant.revision, channel: channel?.revision },
  });
  const label = settingsCopy.tabs.telegram;
  const steps = [
    heartbeatStep({ assistant, label: proactivity.title }),
    ...(channel
      ? [channelStep({ channelId: channel.id, label: settingsCopy.connectionGroup })]
      : []),
  ];
  const after = async (result) => {
    if (result.completed?.length) await Promise.all([refresh(), telegram.reload()]);
    return result;
  };
  const save = async () => after(await draft.save(steps));
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "telegram",
    label,
    save,
  });
  // A Telegram subpage needs a channel; without one the address falls back to the tab.
  useEffect(() => {
    if (telegram.loaded && !channel && page)
      navigate(agentRoute(assistant.id, "telegram"), true, true);
  }, [telegram.loaded, channel, page, assistant.id, navigate]);
  const back = () => go("telegram");
  const subpage =
    channel && page === "telegram-activity" ? (
      <TelegramActivityPage
        assistant={assistant}
        telegram={telegram}
        onBack={back}
        navigate={navigate}
      />
    ) : channel && page === "telegram-connection" ? (
      <TelegramConnectionPage telegram={telegram} onBack={back} />
    ) : null;
  return (
    <section id="agent-telegram" aria-label={channelCopy.title}>
      {subpage ?? (
        <>
          <ConflictNotice draft={draft} labels={conflictLabels} />
          <ConnectionGroup
            assistant={assistant}
            telegram={telegram}
            draft={draft}
            go={go}
            navigate={navigate}
          />
          <ProactivityGroup
            assistant={assistant}
            values={draft.values}
            set={draft.set}
            connected={connected}
          />
          {assistant.capabilities?.reminders && (
            <>
              <RemindersGroup assistantId={assistant.id} connected={connected} />
              <RoutinesGroup assistantId={assistant.id} connected={connected} />
            </>
          )}
        </>
      )}
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        note={assistantCopy.pendingConfigShort}
      />
      <ConfirmationSheet confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </section>
  );
}
