import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { getLanguage } from "../../lib/i18n/index.js";
import { assistantChannelCopy as channelCopy } from "../../lib/i18n/messages/assistant-channel.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { PairingBlock } from "../assistants/settings/TelegramConnection.jsx";
import { userApi } from "./user-api.js";

/**
 * Her own agent's Telegram bot at Extended (server me-telegram.js): she connects it
 * with a BotFather token, pairs her private chat and disconnects it. The token never
 * comes back. Pairing finishes in Telegram: her event stream (`telegram`) re-reads the
 * bot, and a paired bot drops the pairing code.
 */
export default function UserTelegramGroup({ agentId, subscribe }) {
  const [channel, setChannel] = useState(undefined);
  const [token, setToken] = useState("");
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const read = (first) =>
      userApi
        .telegram(agentId)
        .then((result) => {
          if (!current) return;
          setChannel(result.channel);
          if (result.channel?.paired) setPairing(null);
        })
        .catch((e) => {
          if (!current) return;
          if (first) setChannel(null);
          setError(e.message);
        });
    read(true);
    const unsubscribe = subscribe?.((event) => {
      if (event.type === "telegram" && event.agentId === agentId) read(false);
    });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [agentId, subscribe]);
  const act = async (run) => {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(e.message);
    } finally {
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
      setChannel(result.channel);
      setToken("");
      // The same bot connected again is paired already; a new one needs pairing.
      if (!result.channel?.paired) await pair();
    });
  const disconnect = () =>
    act(async () => {
      setChannel((await userApi.disconnectTelegram(agentId)).channel);
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
