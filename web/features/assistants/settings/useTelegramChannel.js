import { useCallback, useState } from "react";
import { getLanguage } from "../../../lib/i18n/index.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { assistantApi } from "../assistant-api.js";

// Telegram notices link back to the address the owner uses AgentPier from.
const browserOrigin = () => window.location.origin;

/**
 * The agent's Telegram channel, following the live `agent.channels:<id>` topic, with
 * its immediate actions.
 */
export default function useTelegramChannel(assistantId) {
  const [token, setToken] = useState(""),
    [pairing, setPairing] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const topic = useLiveTopic(assistantId ? `agent.channels:${assistantId}` : null);
  const { refresh } = topic;
  // The fallback reads every agent's channels; the push carries this agent's only.
  const channel =
    topic.data?.channels?.find((c) => c.assistantId === assistantId) || null;
  const loaded = topic.data !== null;
  const load = useCallback(() => refresh(), [refresh]);
  async function act(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const pair = (record) =>
    assistantApi.pairChannel(
      record.id,
      record.revision,
      record.appUrl || browserOrigin(),
      record.language || getLanguage(),
    );
  // A new token for a stored channel replaces the old one (same bot only).
  async function connect() {
    const record = channel
      ? await assistantApi.updateChannel(channel.id, {
          token,
          revision: channel.revision,
        })
      : await assistantApi.createChannel({
          assistantId,
          token,
          appUrl: browserOrigin(),
          language: getLanguage(),
        });
    setToken("");
    setPairing(record.chatId ? null : await pair(record));
  }
  const showPair = Boolean(
    pairing &&
    channel &&
    !channel.enabled &&
    pairing.channel.revision === channel.revision &&
    (!pairing.expiresAt || pairing.expiresAt > Date.now()),
  );
  return {
    channel,
    loaded,
    token,
    setToken,
    pairing,
    setPairing,
    showPair,
    error: error || topic.error,
    busy,
    act,
    connect,
    pair,
    reload: load,
    origin: browserOrigin(),
  };
}
