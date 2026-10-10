import React, { useCallback, useEffect, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { assistantCopy as messages } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import usePolling from "./usePolling.js";
export default function AssistantReminders({ assistantId }) {
  const copy = messages.personal;
  const [items, setItems] = useState([]),
    [runs, setRuns] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [repeat, setRepeat] = useState("once"),
    [at, setAt] = useState(""),
    [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const identity = useRef(crypto.randomUUID()),
    alive = useRef(true);
  const refresh = useCallback(async () => {
    const result = await assistantApi.reminders(assistantId);
    if (alive.current) setItems(result.reminders || []);
  }, [assistantId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  usePolling(
    () =>
      refresh().catch((e) => {
        if (alive.current) setError(e.message);
      }),
    10000,
    { restartKey: assistantId },
  );
  async function act(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      try {
        await refresh();
      } catch (e) {
        if (alive.current) setError(e.message);
      }
      if (alive.current) setBusy(false);
    }
  }
  function create(event) {
    event.preventDefault();
    act(async () => {
      const date = new Date(at),
        [hours, minutes] = time.split(":").map(Number);
      if (repeat === "once" && !Number.isFinite(date.getTime()))
        throw Error(copy.invalidTime);
      await assistantApi.createReminder(assistantId, {
        clientRequestId: identity.current,
        name,
        message,
        schedule:
          repeat === "once"
            ? { kind: "at", at: date.toISOString() }
            : { kind: "cron", expr: `${minutes} ${hours} * * *`, tz: timezone },
      });
      identity.current = crypto.randomUUID();
      setName("");
      setMessage("");
    });
  }
  const status = (item) =>
    item.status !== "ready"
      ? copy.states[item.status]
      : item.enabled
        ? copy.states.active
        : item.schedule?.kind === "at" && item.lastRunStatus === "ok"
          ? copy.states.completed
          : copy.states.paused;
  return (
    <section className="assistant-form assistant-personal-panel">
      <h2>{copy.reminders}</h2>
      <p className="assistant-note">{copy.remindersHint}</p>
      <ErrorMessage error={error} />
      <form
        onSubmit={create}
        onChange={() => {
          identity.current = crypto.randomUUID();
        }}
      >
        <label>
          {copy.reminderName}
          <input
            disabled={busy}
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {copy.reminderText}
          <textarea
            rows={3}
            disabled={busy}
            required
            maxLength={8192}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <label>
          {copy.repeat}
          <select
            disabled={busy}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          >
            <option value="once">{copy.once}</option>
            <option value="daily">{copy.daily}</option>
          </select>
        </label>
        {repeat === "once" ? (
          <label>
            {copy.when}
            <input
              type="datetime-local"
              disabled={busy}
              required
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
            <span className="assistant-note">
              {copy.localTime(Intl.DateTimeFormat().resolvedOptions().timeZone)}
            </span>
          </label>
        ) : (
          <div className="assistant-model-fields">
            <label>
              {copy.time}
              <input
                type="time"
                disabled={busy}
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label>
              {copy.timezone}
              <input
                disabled={busy}
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
          </div>
        )}
        <button className="button primary" disabled={busy}>
          {copy.createReminder}
        </button>
      </form>
      {!items.length && <p className="assistant-note">{copy.noReminders}</p>}
      {items.map((item) => (
        <article key={item.id} className="assistant-card assistant-reminder-row">
          <h3>{item.name || copy.unknownReminder}</h3>
          <p>{status(item)}</p>
          {item.nextRunAtMs && (
            <p className="assistant-note">
              {copy.nextRun(formatTimestamp(item.nextRunAtMs))}
            </p>
          )}
          {item.deliveryState && (
            <p className="assistant-note">
              {copy.telegramDelivery(
                messages.channel.states[item.deliveryState] || copy.states.unknown,
              )}
            </p>
          )}
          {item.reviewRequired && (
            <p className="assistant-note">{copy.reviewReminderHint}</p>
          )}
          <div className="assistant-actions">
            {item.reviewRequired && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  act(() => assistantApi.reviewReminder(assistantId, item.id))
                }
              >
                {copy.reviewReminder}
              </button>
            )}
            {item.status === "ready" && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  act(() =>
                    assistantApi.updateReminder(assistantId, item.id, {
                      enabled: !item.enabled,
                      revision: item.revision,
                    }),
                  )
                }
              >
                {item.enabled ? copy.pauseReminder : copy.resumeReminder}
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => act(() => assistantApi.removeReminder(assistantId, item.id))}
            >
              {copy.removeReminder}
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const result = await assistantApi.reminderRuns(assistantId, item.id);
                  if (alive.current)
                    setRuns((r) => ({ ...r, [item.id]: result.entries }));
                })
              }
            >
              {copy.history}
            </button>
          </div>
          {runs[item.id]?.length === 0 && <p className="assistant-note">{copy.noRuns}</p>}
          {runs[item.id]?.map((run, i) => (
            <p className="assistant-note" key={i}>
              {formatTimestamp(run.runAtMs)} ·{" "}
              {copy.states[run.completionStatus] ||
                copy.states[run.status] ||
                copy.states.unknown}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}
