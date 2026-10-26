import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import SubpageHeader from "./SubpageHeader.jsx";
import { PairingBlock } from "./TelegramConnection.jsx";

/** Bot identity, diagnostics, ignored messages, a new pairing code and token replacement. */
export default function TelegramConnectionPage({ telegram, onBack }) {
  const copy = assistantCopy.channel;
  const { channel } = telegram;
  const ignored = channel.ignoredMessages || {};
  return (
    <>
      <SubpageHeader
        title={settingsCopy.connectionPage}
        tab="channels"
        onBack={onBack}
        hint={copy.description}
      />
      <ErrorMessage error={telegram.error} />
      <div className="list-card agent-fields">
        <p className="agent-row-note">
          <strong>@{channel.username}</strong> ·{" "}
          {channel.enabled
            ? copy.connected(channel.chatId)
            : channel.hasSecret
              ? copy.paused
              : copy.disconnected}
        </p>
        {channel.diagnostic && (
          <p role="status" className="agent-row-note">
            {copy.diagnostics[channel.diagnostic] || copy.failed}
          </p>
        )}
        {Boolean(ignored.private || ignored.group) && (
          <p className="agent-row-note">
            {copy.ignored(ignored.private || 0, ignored.group || 0)}
          </p>
        )}
        {channel.notificationDiagnostic && (
          <p className="agent-row-note">
            {copy.diagnostics[channel.notificationDiagnostic] || copy.failed}
          </p>
        )}
      </div>
      {channel.hasSecret && !channel.enabled && (
        <button
          type="button"
          className="button secondary"
          disabled={telegram.busy}
          onClick={() =>
            telegram.act(async () => telegram.setPairing(await telegram.pair(channel)))
          }
        >
          {copy.newPair}
        </button>
      )}
      {telegram.showPair && <PairingBlock pairing={telegram.pairing} />}
      {channel.hasSecret && (
        <form
          className="list-card agent-fields"
          onSubmit={(event) => {
            event.preventDefault();
            telegram.act(telegram.connect);
          }}
        >
          <label className="agent-field">
            {settingsCopy.replaceToken}
            <input
              required
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={telegram.token}
              onChange={(event) => telegram.setToken(event.target.value)}
            />
          </label>
          <p className="agent-row-note">{settingsCopy.replaceTokenHint}</p>
          <div className="agent-field">
            <button className="button secondary" disabled={telegram.busy}>
              {commonCopy.saveToken}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
