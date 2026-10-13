import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { SelectRow, unknownValue } from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import RouteLink from "../RouteLink.jsx";
import { agentRoute, channelActivity } from "./agent-settings-fields.js";

/** The start message and link that pair the owner's private chat. */
export function PairingBlock({ pairing }) {
  const copy = assistantCopy.channel;
  return (
    <div className="list-card agent-pairing">
      <p>{copy.pairHint}</p>
      <code className="assistant-pair-code">/start {pairing.code}</code>
      <a
        className="button secondary"
        href={pairing.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {copy.pair}
      </a>
    </div>
  );
}

function activityStatus({ attention, entries }) {
  if (attention) return { tone: "warn", text: settingsCopy.activityAttention(attention) };
  return entries.length ? { tone: "ok", text: settingsCopy.allDelivered } : undefined;
}

/** "Verbindung": the bot's state and actions, language and address drafts, subpage rows. */
export function ConnectionGroup({ assistant, telegram, draft, go, navigate }) {
  const id = useId();
  const copy = assistantCopy.channel;
  const { channel } = telegram;
  const connected = Boolean(channel?.hasSecret);
  const activity = channelActivity(channel);
  const link = (page) => ({
    href: routePath(agentRoute(assistant.id, "telegram", page)),
    onClick: () => go("telegram", page),
  });
  // Activity and connection details stay reachable after a disconnect: entries may
  // still need a decision.
  const subpageRows = channel && (
    <>
      <ListRow
        label={copy.activity}
        status={activityStatus(activity)}
        value={activity.entries.length ? undefined : settingsCopy.noActivity}
        {...link("telegram-activity")}
      />
      <ListRow label={settingsCopy.connectionPage} {...link("telegram-connection")} />
    </>
  );
  // The language and address fields leave with the connection, so their edits do too.
  const disconnect = () =>
    telegram.act(async () => {
      await assistantApi.disconnectChannel(channel.id, channel.revision);
      draft.update({ language: draft.base.language, appUrl: draft.base.appUrl });
    });
  const toggle = () =>
    telegram.act(() =>
      assistantApi.updateChannel(channel.id, {
        enabled: !channel.enabled,
        revision: channel.revision,
      }),
    );
  return (
    <section aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={`${copy.description} ${copy.languageHint} ${copy.appUrlHint}`}
      >
        {settingsCopy.connectionGroup}
      </GroupLabel>
      <ErrorMessage error={telegram.error} />
      {channel?.diagnostic && (
        <p role="status" className="assistant-notice">
          {copy.diagnostics[channel.diagnostic] || copy.failed}
        </p>
      )}
      {channel?.notificationDiagnostic && (
        <p className="assistant-notice">
          {copy.diagnostics[channel.notificationDiagnostic] || copy.failed}
        </p>
      )}
      {!telegram.loaded ? (
        <ListCard labelledBy={id}>
          <ListRow label={copy.title} value={unknownValue} />
        </ListCard>
      ) : !connected ? (
        <form
          className="list-card agent-fields"
          onSubmit={(event) => {
            event.preventDefault();
            telegram.act(telegram.connect);
          }}
        >
          {channel && (
            <p className="agent-row-note">
              @{channel.username} · {copy.disconnected}
            </p>
          )}
          <label className="agent-field">
            {copy.token}
            <input
              required
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={telegram.token}
              onChange={(event) => telegram.setToken(event.target.value)}
            />
          </label>
          <p className="agent-row-note">{copy.botHint}</p>
          <div className="agent-field">
            <button className="button primary" disabled={telegram.busy}>
              {copy.connect}
            </button>
          </div>
        </form>
      ) : (
        <ListCard labelledBy={id}>
          <ListRow
            label={`@${channel.username}`}
            sub={channel.enabled ? copy.connected(channel.chatId) : copy.paused}
          />
          {channel.chatId && (
            <ListRow
              label={channel.enabled ? copy.pause : copy.resume}
              chevron={false}
              disabled={telegram.busy}
              onClick={toggle}
            />
          )}
          <ListRow
            label={copy.disconnect}
            chevron={false}
            className="danger"
            disabled={telegram.busy}
            onClick={disconnect}
          />
          <SelectRow
            label={copy.language}
            value={draft.values.language}
            options={[
              { value: "de", label: copy.languageDe },
              { value: "en", label: copy.languageEn },
            ]}
            disabled={draft.saving}
            onChange={(value) => draft.set("language", value)}
          />
          <label className="list-row agent-field">
            {copy.appUrl}
            <input
              type="url"
              value={draft.values.appUrl}
              placeholder={telegram.origin}
              maxLength={2048}
              disabled={draft.saving}
              onChange={(event) => draft.set("appUrl", event.target.value)}
            />
          </label>
          {subpageRows}
        </ListCard>
      )}
      {telegram.loaded && !connected && channel && (
        <ListCard labelledBy={id} className="agent-telegram-details">
          {subpageRows}
        </ListCard>
      )}
      {telegram.showPair && <PairingBlock pairing={telegram.pairing} />}
      <RouteLink route={{ view: "accounts" }} navigate={navigate}>
        {copy.speechLink}
      </RouteLink>
    </section>
  );
}
