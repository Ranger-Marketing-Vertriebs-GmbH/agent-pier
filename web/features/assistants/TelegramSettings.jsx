import React, { useCallback, useEffect, useRef, useState } from "react";
import RouteLink from "./RouteLink.jsx";
import usePolling from "./usePolling.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { getLanguage } from "../../lib/i18n/index.js";
import { assistantApi } from "./assistant-api.js";
const recoveryStates = [
  "transcription_failed",
  "delivery_failed",
  "delivery_uncertain",
  "reply_unavailable",
  "model_reviewed",
  "model_uncertain",
];
const inProgress = [
  "queued",
  "voice_pending",
  "transcribing",
  "dispatching",
  "running",
  "outbound",
  "delivering",
];
// Telegram notices link back to the address the owner uses AgentPier from.
const browserOrigin = () => window.location.origin;
export default function TelegramSettings({ assistantId, navigate }) {
  const copy = assistantCopy.channel;
  const [channel, setChannel] = useState(null),
    [token, setToken] = useState(""),
    [appUrl, setAppUrl] = useState(null),
    [pairing, setPairing] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(null);
  const load = useCallback(async () => {
    const ticket = {};
    generation.current = ticket;
    const result = await assistantApi.channels();
    if (generation.current === ticket)
      setChannel(result.channels.find((c) => c.assistantId === assistantId) || null);
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
  const pair = (record) =>
    assistantApi.pairChannel(
      record.id,
      record.revision,
      record.appUrl || browserOrigin(),
      record.language || getLanguage(),
    );
  const showPair =
    pairing &&
    channel &&
    !channel.enabled &&
    pairing.channel.revision === channel.revision &&
    (!pairing.expiresAt || pairing.expiresAt > Date.now());
  const inputs = [...(channel?.inputs || []), ...(channel?.notifications || [])];
  const visibleInputs = [
    ...new Map(
      [
        ...inputs.filter((entry) => recoveryStates.includes(entry.state)),
        ...inputs.slice(-20).reverse(),
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  return (
    <section className="assistant-accounts" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <p className="assistant-note">{copy.description}</p>
      <ErrorMessage error={error} />
      <div className="assistant-form">
        {channel && (
          <>
            <strong>@{channel.username}</strong>
            <p className="assistant-note">
              {channel.enabled
                ? copy.connected(channel.chatId)
                : channel.hasSecret
                  ? copy.paused
                  : copy.disconnected}
            </p>
            {channel.diagnostic && (
              <p role="status">{copy.diagnostics[channel.diagnostic] || copy.failed}</p>
            )}
            {!!(channel.ignoredMessages?.private || channel.ignoredMessages?.group) && (
              <p className="assistant-note">
                {copy.ignored(
                  channel.ignoredMessages.private || 0,
                  channel.ignoredMessages.group || 0,
                )}
              </p>
            )}
            {channel.notificationDiagnostic && (
              <p className="assistant-note">
                {copy.diagnostics[channel.notificationDiagnostic] || copy.failed}
              </p>
            )}
          </>
        )}
        {(!channel || !channel.hasSecret) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act(connect);
            }}
          >
            <label>
              {copy.token}
              <input
                required
                type="password"
                autoComplete="new-password"
                value={token}
                maxLength={256}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p className="assistant-note">{copy.botHint}</p>
            <button className="button primary" disabled={busy}>
              {copy.connect}
            </button>
          </form>
        )}
        {showPair && (
          <div className="assistant-login">
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
        )}
        {channel?.hasSecret && (
          <div className="assistant-actions">
            {!channel.enabled && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => act(async () => setPairing(await pair(channel)))}
              >
                {copy.newPair}
              </button>
            )}
            {channel.chatId && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  act(() =>
                    assistantApi.updateChannel(channel.id, {
                      enabled: !channel.enabled,
                      revision: channel.revision,
                    }),
                  )
                }
              >
                {channel.enabled ? copy.pause : copy.resume}
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                act(() => assistantApi.disconnectChannel(channel.id, channel.revision))
              }
            >
              {copy.disconnect}
            </button>
          </div>
        )}
        {channel?.hasSecret && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                await assistantApi.updateChannel(channel.id, {
                  appUrl: (appUrl ?? channel.appUrl ?? "").trim() || null,
                  revision: channel.revision,
                });
                setAppUrl(null);
              });
            }}
          >
            <label>
              {copy.appUrl}
              <input
                type="url"
                value={appUrl ?? channel.appUrl ?? ""}
                placeholder={browserOrigin()}
                maxLength={2048}
                onChange={(e) => setAppUrl(e.target.value)}
              />
            </label>
            <p className="assistant-note">{copy.appUrlHint}</p>
            <button className="button secondary" disabled={busy}>
              {copy.saveAppUrl}
            </button>
          </form>
        )}
        {channel?.hasSecret && (
          <label>
            {copy.language}
            <select
              value={channel.language || "de"}
              disabled={busy}
              onChange={(e) =>
                act(() =>
                  assistantApi.updateChannel(channel.id, {
                    language: e.target.value,
                    revision: channel.revision,
                  }),
                )
              }
            >
              <option value="de">{copy.languageDe}</option>
              <option value="en">{copy.languageEn}</option>
            </select>
          </label>
        )}
        {channel?.hasSecret && <p className="assistant-note">{copy.languageHint}</p>}
        <RouteLink route={{ view: "accounts" }} navigate={navigate}>
          {copy.speechLink}
        </RouteLink>
      </div>
      {!!inputs.length && (
        <div className="assistant-channel-inputs">
          <h3>{copy.activity}</h3>
          {visibleInputs.map((entry) => (
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
              {inProgress.includes(entry.state) && (
                <p className="assistant-note">{copy.inProgress}</p>
              )}
              <div className="assistant-actions">
                {["transcription_failed", "delivery_failed"].includes(entry.state) &&
                  entry.diagnostic !== "CHANNEL_DESTINATION_CHANGED" && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          (entry.notification
                            ? assistantApi.recoverNotification
                            : assistantApi.recoverInput)(channel.id, entry.id, "retry"),
                        )
                      }
                    >
                      {copy.retry}
                    </button>
                  )}
                {(entry.needsReview || recoveryStates.includes(entry.state)) && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        (entry.notification
                          ? assistantApi.recoverNotification
                          : assistantApi.recoverInput)(channel.id, entry.id, "review"),
                      )
                    }
                  >
                    {copy.review}
                  </button>
                )}
                {entry.state === "model_uncertain" && (
                  <RouteLink
                    route={{
                      view: "agents",
                      assistantId,
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
      )}
    </section>
  );
}
