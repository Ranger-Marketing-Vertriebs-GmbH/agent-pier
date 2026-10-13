import { useCallback, useEffect, useRef, useState } from "react";
import { getLanguage } from "../../../lib/i18n/index.js";
import usePolling from "../usePolling.js";
import { assistantApi } from "../assistant-api.js";

// Telegram notices link back to the address the owner uses AgentPier from.
const browserOrigin = () => window.location.origin;

/** The agent's Telegram channel, polled every 2 s, with its immediate actions. */
export default function useTelegramChannel(assistantId) {
  const [channel, setChannel] = useState(null),
    [loaded, setLoaded] = useState(false),
    [token, setToken] = useState(""),
    [pairing, setPairing] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(null);
  const load = useCallback(async () => {
    const ticket = {};
    generation.current = ticket;
    const result = await assistantApi.channels();
    if (generation.current !== ticket) return;
    setChannel(result.channels.find((c) => c.assistantId === assistantId) || null);
    setLoaded(true);
  }, [assistantId]);
  useEffect(
    () => () => {
      generation.current = null;
    },
    [assistantId],
  );
  usePolling(
    async (signal) => {
      try {
        await load();
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    2000,
    { restartKey: assistantId },
  );
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
    error,
    busy,
    act,
    connect,
    pair,
    reload: load,
    origin: browserOrigin(),
  };
}
