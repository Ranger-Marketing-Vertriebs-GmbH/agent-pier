import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { getLanguage } from "../../lib/i18n/index.js";
import { assistantChannelCopy as channelCopy } from "../../lib/i18n/messages/assistant-channel.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { PairingBlock } from "../assistants/settings/TelegramConnection.jsx";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { userApi } from "./user-api.js";

/**
 * Her own agent's Telegram bot at Extended (server me-telegram.js): she connects it
 * with a BotFather token, pairs her private chat and disconnects it. The token never
 * comes back. Pairing finishes in Telegram: her live topic `me.telegram:<agentId>`
 * pushes the paired bot, which drops the pairing code.
 */
export default function UserTelegramGroup({ agentId }) {
  const topic = useLiveTopic(`me.telegram:${agentId}`);
  const [pairing, setPairing] = useState(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const { refresh } = topic;
  // Unknown while the first read runs; none once it failed.
  const channel = topic.data ? topic.data.channel : topic.loading ? undefined : null;
  const paired = Boolean(channel?.paired);
  useEffect(() => {
    if (paired) setPairing(null);
  }, [paired]);
  const error = failure || topic.error;
  const act = async (run) => {
    setBusy(true);
    setFailure("");
    try {
      await run();
    } catch (e) {
      setFailure(e.message);
    } finally {
      // Her app shows the bot as the server has it now; a push meanwhile is newer.
      await refresh();
      setBusy(false);
    }
  };
  const pair = async () => setPairing(await userApi.pairTelegram(agentId));
  const connect = () =>
    act(async () => {
      const result = await userApi.connectTelegram(agentId, {
        token,
        language: getLanguage(),
      });
      setToken("");
      // The same bot connected again is paired already; a new one needs pairing.
      if (!result.channel?.paired) await pair();
    });
  const disconnect = () =>
    act(async () => {
      await userApi.disconnectTelegram(agentId);
      setPairing(null);
    });
  return (
    <>
      <GroupLabel id="user-telegram" hint={copy.telegramHint}>
        {channelCopy.title}
      </GroupLabel>
      <ErrorMessage error={error} />
      {channel === undefined ? (
        <ListCard labelledBy="user-telegram">
          <ListRow label={channelCopy.title} value={unknownValue} />
        </ListCard>
      ) : !channel?.connected ? (
        <form
          className="list-card agent-fields"
          aria-labelledby="user-telegram"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          {channel && (
            <p className="agent-row-note">
              @{channel.username} · {channelCopy.disconnected}
            </p>
          )}
          <label className="agent-field">
            {channelCopy.token}
            <input
              required
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={token}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <p className="agent-row-note">{channelCopy.botHint}</p>
          <div className="agent-field">
            <button className="button primary" disabled={busy}>
              {channelCopy.connect}
            </button>
          </div>
        </form>
      ) : (
        <ListCard labelledBy="user-telegram">
          <ListRow
            label={`@${channel.username}`}
            sub={
              channel.paired
                ? copy.telegramConnected(channel.username)
                : channelCopy.paused
            }
          />
          {!channel.paired && (
            <ListRow
              label={pairing ? channelCopy.newPair : channelCopy.pair}
              chevron={false}
              disabled={busy}
              onClick={() => act(pair)}
            />
          )}
          <ListRow
            label={channelCopy.disconnect}
            chevron={false}
            className="danger"
            disabled={busy}
            onClick={disconnect}
          />
        </ListCard>
      )}
      {pairing && channel?.connected && !channel.paired && (
        <PairingBlock pairing={pairing} />
      )}
    </>
  );
}
