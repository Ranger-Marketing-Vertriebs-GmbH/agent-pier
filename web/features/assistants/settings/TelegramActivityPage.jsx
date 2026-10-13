import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import RouteLink from "../RouteLink.jsx";
import {
  channelActivity,
  inProgressStates,
  recoveryStates,
} from "./agent-settings-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";

/** Telegram inputs and notices with retry, acknowledge and "review agent chat". */
export default function TelegramActivityPage({ assistant, telegram, onBack, navigate }) {
  const copy = assistantCopy.channel;
  const { channel } = telegram;
  const { visible } = channelActivity(channel);
  const recover = (entry, action) =>
    telegram.act(() =>
      (entry.notification ? assistantApi.recoverNotification : assistantApi.recoverInput)(
        channel.id,
        entry.id,
        action,
      ),
    );
  return (
    <>
      <SubpageHeader title={copy.activity} tab="telegram" onBack={onBack} />
      <ErrorMessage error={telegram.error} />
      {!visible.length && <p className="assistant-note">{settingsCopy.noActivity}</p>}
      <div className="assistant-channel-inputs">
        {visible.map((entry) => (
          <article className="assistant-card" key={entry.id}>
            <strong>{copy.states[entry.state] || copy.failed}</strong>
            {entry.notification && (
              <p className="assistant-note">{copy.teamNotification}</p>
            )}
            <p className="assistant-channel-text">{entry.text || copy.voice}</p>
            {entry.diagnostic && (
              <p className="assistant-note">
                {copy.diagnostics[entry.diagnostic] || copy.failed}
              </p>
            )}
            {entry.diagnosticDetail && (
              <p className="assistant-note">
                <code>{entry.diagnosticDetail}</code>
              </p>
            )}
            {inProgressStates.includes(entry.state) && (
              <p className="assistant-note">{copy.inProgress}</p>
            )}
            <div className="assistant-actions">
              {["transcription_failed", "delivery_failed"].includes(entry.state) &&
                entry.diagnostic !== "CHANNEL_DESTINATION_CHANGED" && (
                  <button
                    className="button secondary"
                    disabled={telegram.busy}
                    onClick={() => recover(entry, "retry")}
                  >
                    {copy.retry}
                  </button>
                )}
              {(entry.needsReview || recoveryStates.includes(entry.state)) && (
                <button
                  className="button secondary"
                  disabled={telegram.busy}
                  onClick={() => recover(entry, "review")}
                >
                  {copy.review}
                </button>
              )}
              {entry.state === "model_uncertain" && (
                <RouteLink
                  route={{
                    view: "agents",
                    assistantId: assistant.id,
                    conversationId: channel.conversationId,
                  }}
                  navigate={navigate}
                >
                  {copy.openChat}
                </RouteLink>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
