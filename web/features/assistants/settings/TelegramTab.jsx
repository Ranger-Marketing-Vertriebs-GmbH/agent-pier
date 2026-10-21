import React, { useEffect } from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import useAssistants from "../useAssistants.js";
import { agentRoute, isPersonal, telegramServer } from "./agent-settings-fields.js";
import { channelStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useTelegramChannel from "./useTelegramChannel.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import { ConnectionGroup } from "./TelegramConnection.jsx";
import TelegramConnectionPage from "./TelegramConnectionPage.jsx";
import TelegramActivityPage from "./TelegramActivityPage.jsx";
import TelegramSendersSettings from "../TelegramSendersSettings.jsx";
import Icon from "../../../components/Icon.jsx";

const channelCopy = assistantCopy.channel;
const conflictLabels = {
  language: () => channelCopy.language,
  appUrl: () => channelCopy.appUrl,
};

/** Why a tab section is absent for an agent of users. */
function UserAgentNote({ text }) {
  return (
    <p className="agent-locked-notice" role="note">
      <Icon name="shield" size={16} />
      <span>{text}</span>
    </p>
  );
}

/**
 * Telegram: the connection, its notice settings and the agent's own bot. Reminders,
 * routines and check-ins live on their own tab and only use Telegram as an extra.
 * A user's own agent has her bot only (managed in her app), and no agent of users
 * gets a bot for other people (user-agent-lock.js).
 */
export default function TelegramTab({ assistant, page, go, navigate }) {
  const { refresh } = useAssistants();
  const own = assistant.userAccess?.mode === "own";
  const loaded = useTelegramChannel(assistant.id);
  // Her own agent's only bot is hers: the owner never sees or acts on it here.
  const telegram = own ? { ...loaded, channel: null } : loaded;
  const { channel } = telegram;
  const draft = useTabDraft({
    server: telegramServer(channel),
    revisions: { channel: channel?.revision },
  });
  const label = settingsCopy.tabs.telegram;
  const steps = channel
    ? [channelStep({ channelId: channel.id, label: settingsCopy.connectionGroup })]
    : [];
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
          {own ? (
            <UserAgentNote
              text={
                assistant.userAccess.members[0]?.level === "extended"
                  ? usersCopy.ownTelegram
                  : usersCopy.ownTelegramBelowExtended
              }
            />
          ) : (
            <ConnectionGroup
              assistant={assistant}
              telegram={telegram}
              draft={draft}
              go={go}
              navigate={navigate}
            />
          )}
          {/* Its own bot for other people: immediate actions, outside the draft. */}
          {assistant.userAccess ? (
            <UserAgentNote text={usersCopy.lockedTelegramSenders} />
          ) : (
            isPersonal(assistant) && (
              <TelegramSendersSettings assistantId={assistant.id} />
            )
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
