import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { telegramSendersCopy } from "../../lib/i18n/messages/telegram-senders.js";
import { assistantApi } from "./assistant-api.js";
import RestartConfirmation from "./RestartConfirmation.jsx";
import usePolling from "./usePolling.js";
import { restartRequired } from "../provider-connections/restart-confirmation.js";

const telegramUserId = /^[1-9]\d{0,19}$/;

/**
 * The agent's own Telegram bot for other people: its token (written here, never
 * shown again), the people it admits and its state. Changed people apply live; any
 * other change the running agent service was not started with (a bot, a token)
 * restarts it once the owner confirms.
 */
export default function TelegramSendersSettings({ assistantId }) {
  const copy = telegramSendersCopy;
  const [data, setData] = useState(null),
    [token, setToken] = useState(""),
    [draft, setDraft] = useState([]),
    [personId, setPersonId] = useState(""),
    [personName, setPersonName] = useState(""),
    [error, setError] = useState(""),
    [pollError, setPollError] = useState(""),
    [busy, setBusy] = useState(false),
    [restart, setRestart] = useState(null);
  usePolling(
    async (signal) => {
      try {
        const next = await assistantApi.telegramSenders(assistantId, signal);
        if (!signal.aborted) {
          setData(next);
          setPollError("");
        }
      } catch (e) {
        if (!signal.aborted) setPollError(e.message);
      }
    },
    5000,
    { restartKey: assistantId },
  );
  const bot = data?.bot || null;
  const people = bot ? bot.people : draft;
  // Runs `operation(confirmRestart)`, then `done()`; asks the owner first when the
  // server needs a restart, then repeats the same request with the confirmation.
  async function run(operation, confirmRestart = false, done = () => {}) {
    setBusy(true);
    setError("");
    try {
      const next = await operation(confirmRestart);
      if (next && "bot" in next) setData(next);
      else setData(await assistantApi.telegramSenders(assistantId));
      setRestart(null);
      done();
    } catch (e) {
      if (restartRequired(e)) setRestart({ affected: e.affected || {}, operation, done });
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const save = (input, done) =>
    run(
      (confirmRestart) =>
        assistantApi.saveTelegramSenders(assistantId, {
          ...input,
          revision: bot ? bot.revision : null,
          ...(confirmRestart ? { confirmRestart: true } : {}),
        }),
      false,
      done,
    );
  const clearPerson = () => {
    setPersonId("");
    setPersonName("");
  };
  function addPerson(event) {
    event.preventDefault();
    const id = personId.trim();
    const name = personName.trim();
    if (!telegramUserId.test(id)) return setError(copy.invalidId);
    if (people.some((p) => p.id === id)) return setError(copy.duplicate);
    setError("");
    const next = [...people, { id, name }];
    if (bot) return save({ people: next }, clearPerson);
    setDraft(next);
    clearPerson();
  }
  function removePerson(id) {
    const next = people.filter((p) => p.id !== id);
    if (!bot) setDraft(next);
    else save({ people: next });
  }
  function connect(event) {
    event.preventDefault();
    save(bot ? { token } : { token, people: draft }, () => {
      setToken("");
      setDraft([]);
    });
  }
  const disconnect = () =>
    run((confirmRestart) =>
      assistantApi.removeTelegramSenders(assistantId, {
        revision: bot.revision,
        ...(confirmRestart ? { confirmRestart: true } : {}),
      }),
    );
  const apply = () =>
    run((confirmRestart) =>
      assistantApi.applyTelegramSenders(confirmRestart ? { confirmRestart: true } : {}),
    );
  const state = bot && data.status?.state;
  // An agent with shell, a stdio MCP server or SSH grants cannot get a bot (server
  // enforced).
  const blocked =
    data && !bot
      ? data.shell && data.shell !== "off"
        ? copy.shellBlocked
        : data.stdio
          ? copy.stdioBlocked
          : data.ssh
            ? copy.sshBlocked
            : ""
      : "";
  // Saved, but the agent service still runs something else; also after a removal.
  const pending =
    !!data && (data.pending || data.revocationFailed || state === "pending");
  // The pending change is only allowed people: "Apply now" needs no restart.
  const live = !!data?.pendingLive && !data.revocationFailed;
  return (
    <section className="assistant-accounts" aria-label={copy.title}>
      <GroupLabel hint={copy.description}>{copy.title}</GroupLabel>
      <p className="assistant-note">{copy.boundary}</p>
      <ErrorMessage error={error || pollError} />
      {pending && (
        <div className="assistant-actions">
          {data.revocationFailed ? (
            <p className="assistant-notice" role="alert">
              {copy.revocationFailed}
            </p>
          ) : (
            <p className="assistant-note" role="status">
              {live ? copy.pendingLive : bot ? copy.pending : copy.removedPending}
            </p>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={apply}
          >
            {copy.apply}
          </button>
        </div>
      )}
      {blocked && (
        <p className="assistant-note" role="note">
          {blocked}
        </p>
      )}
      {data && !blocked && (
        <div className="assistant-form">
          {bot && (
            <>
              <strong>{copy.bot(bot.username)}</strong>
              <p className="assistant-note" role="status">
                {copy.status(
                  (state === "pending" && live
                    ? copy.states.pendingLive
                    : copy.states[state]) || copy.states.inactive,
                )}
              </p>
            </>
          )}
          <h3>{copy.people}</h3>
          <p className="assistant-note">{copy.peopleHint}</p>
          {people.length ? (
            <ul className="assistant-telegram-people">
              {people.map((person) => (
                <li key={person.id}>
                  <span>
                    <strong>{person.name}</strong> <code>{person.id}</code>
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={copy.removePerson(person.name)}
                    onClick={() => removePerson(person.id)}
                  >
                    {copy.remove}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="assistant-note" role="status">
              {copy.noPeople}
            </p>
          )}
          <form className="assistant-telegram-person" onSubmit={addPerson}>
            <label>
              {copy.personName}
              <input
                required
                maxLength={100}
                value={personName}
                onChange={(e) => setPersonName(e.target.value)}
              />
            </label>
            <label>
              {copy.personId}
              <input
                required
                inputMode="numeric"
                maxLength={20}
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
              />
            </label>
            <button className="button secondary" disabled={busy}>
              {copy.addPerson}
            </button>
          </form>
          <p className="assistant-note">{data.voice ? copy.voiceOn : copy.voiceOff}</p>
          <form onSubmit={connect}>
            <label>
              {bot ? copy.replaceToken : copy.token}
              <input
                required
                type="password"
                autoComplete="new-password"
                value={token}
                maxLength={256}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p className="assistant-note">{copy.tokenHint}</p>
            <div className="assistant-actions">
              <button className="button primary" disabled={busy}>
                {bot ? copy.saveToken : copy.connect}
              </button>
              {bot && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={disconnect}
                >
                  {copy.disconnect}
                </button>
              )}
            </div>
          </form>
          {restart && (
            <RestartConfirmation
              affected={restart.affected}
              busy={busy}
              onConfirm={() => run(restart.operation, true, restart.done)}
              onCancel={() => setRestart(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}
