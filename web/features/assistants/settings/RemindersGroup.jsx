import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { routineCopy } from "../../../lib/i18n/messages/assistant-routines.js";
import { assistantApi } from "../assistant-api.js";
import usePolling from "../usePolling.js";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The owner's reminder routes; a user's app passes hers (UserRemindersGroup.jsx). */
export const ownerReminderApi = {
  list: assistantApi.reminders,
  create: assistantApi.createReminder,
  update: assistantApi.updateReminder,
  remove: assistantApi.removeReminder,
  review: assistantApi.reviewReminder,
  runs: assistantApi.reminderRuns,
};

/**
 * Reminders delivered to the agent's chat with a push notification, and to a
 * `paired` Telegram chat where switched on; every action applies at once. `api`
 * holds the routes (`review` and `runs` are optional); `readOnly` lists them only.
 */
export default function RemindersGroup({
  assistantId,
  paired = false,
  api = ownerReminderApi,
  readOnly = false,
}) {
  const copy = assistantCopy.personal;
  const id = useId();
  const [items, setItems] = useState([]),
    [runs, setRuns] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [open, setOpen] = useState(null);
  const [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [repeat, setRepeat] = useState("once"),
    [at, setAt] = useState(""),
    [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(browserZone()),
    [telegram, setTelegram] = useState(false);
  const identity = useRef(crypto.randomUUID()),
    alive = useRef(true);
  const refresh = useCallback(async () => {
    const result = await api.list(assistantId);
    if (alive.current) setItems(result.reminders || []);
  }, [assistantId, api]);
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
  async function act(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch (e) {
      if (alive.current) setError(e.message);
      return false;
    } finally {
      try {
        await refresh();
      } catch (e) {
        if (alive.current) setError(e.message);
      }
      if (alive.current) setBusy(false);
    }
  }
  async function create(event) {
    event.preventDefault();
    const done = await act(async () => {
      const date = new Date(at),
        [hours, minutes] = time.split(":").map(Number);
      if (repeat === "once" && !Number.isFinite(date.getTime()))
        throw Error(copy.invalidTime);
      await api.create(assistantId, {
        clientRequestId: identity.current,
        name,
        message,
        schedule:
          repeat === "once"
            ? { kind: "at", at: date.toISOString() }
            : { kind: "cron", expr: `${minutes} ${hours} * * *`, tz: timezone },
        ...(paired && telegram ? { telegram: true } : {}),
      });
      identity.current = crypto.randomUUID();
      setName("");
      setMessage("");
    });
    if (done && alive.current) setCreating(false);
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
    <section id="agent-reminders" aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={copy.remindersHint}
        action={
          readOnly
            ? undefined
            : {
                label: settingsCopy.addReminder,
                onClick: () => setCreating((value) => !value),
                disabled: busy,
              }
        }
      >
        {copy.reminders}
      </GroupLabel>
      <ErrorMessage error={error} />
      {creating && (
        <form
          className="list-card agent-fields"
          onSubmit={create}
          onChange={() => {
            identity.current = crypto.randomUUID();
          }}
        >
          <label className="agent-field">
            {copy.reminderName}
            <input
              disabled={busy}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="agent-field">
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
          <label className="agent-field">
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
            <label className="agent-field">
              {copy.when}
              <input
                type="datetime-local"
                disabled={busy}
                required
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
              <span className="assistant-note">{copy.localTime(browserZone())}</span>
            </label>
          ) : (
            <>
              <label className="agent-field">
                {copy.time}
                <input
                  type="time"
                  disabled={busy}
                  required
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <label className="agent-field">
                {copy.timezone}
                <input
                  disabled={busy}
                  required
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>
            </>
          )}
          {paired && (
            <ToggleRow
              label={routineCopy.alsoTelegram}
              checked={telegram}
              disabled={busy}
              onChange={setTelegram}
            />
          )}
          <div className="agent-field assistant-actions">
            <button className="button primary" disabled={busy}>
              {copy.createReminder}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setCreating(false)}
            >
              {commonCopy.cancel}
            </button>
          </div>
        </form>
      )}
      <ListCard labelledBy={id}>
        {!items.length && <p className="agent-row-note">{copy.noReminders}</p>}
        {items.map((item) => (
          <React.Fragment key={item.id}>
            <div className="list-row two-line">
              <button
                type="button"
                className="list-row-main"
                aria-expanded={open === item.id}
                aria-controls={`${id}-detail-${item.id}`}
                onClick={() => setOpen(open === item.id ? null : item.id)}
              >
                <span className="list-row-text">
                  <span className="list-row-label">
                    {item.name || copy.unknownReminder}
                  </span>
                  <span className="list-row-sub">
                    <span>{status(item)}</span>
                    {item.telegram && (
                      <span className="agent-sub-part">{routineCopy.telegramOn}</span>
                    )}
                    {item.nextRunAtMs && (
                      <span className="agent-sub-part">
                        {copy.nextRun(formatTimestamp(item.nextRunAtMs))}
                      </span>
                    )}
                  </span>
                </span>
                <Icon name="down" size={14} className="list-row-chevron" />
              </button>
            </div>
            {item.reviewRequired && api.review && (
              <div className="agent-row-note">
                <p>{copy.reviewReminderHint}</p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => act(() => api.review(assistantId, item.id))}
                >
                  {copy.reviewReminder}
                </button>
              </div>
            )}
            {open === item.id && (
              <div className="agent-detail" id={`${id}-detail-${item.id}`}>
                {(paired || item.telegram) && item.status === "ready" && !readOnly && (
                  <ToggleRow
                    label={routineCopy.alsoTelegram}
                    checked={item.telegram === true}
                    disabled={busy || (!paired && !item.telegram)}
                    onChange={(next) =>
                      act(() =>
                        api.update(assistantId, item.id, {
                          telegram: next,
                          revision: item.revision,
                        }),
                      )
                    }
                  />
                )}
                {item.deliveryState && (
                  <p>
                    {copy.telegramDelivery(
                      assistantCopy.channel.states[item.deliveryState] ||
                        copy.states.unknown,
                    )}
                  </p>
                )}
                <div className="assistant-actions">
                  {item.status === "ready" && !readOnly && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api.update(assistantId, item.id, {
                            enabled: !item.enabled,
                            revision: item.revision,
                          }),
                        )
                      }
                    >
                      {item.enabled ? copy.pauseReminder : copy.resumeReminder}
                    </button>
                  )}
                  {!readOnly && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => act(() => api.remove(assistantId, item.id))}
                    >
                      {copy.removeReminder}
                    </button>
                  )}
                  {api.runs && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          const result = await api.runs(assistantId, item.id);
                          if (alive.current)
                            setRuns((current) => ({
                              ...current,
                              [item.id]: result.entries,
                            }));
                        })
                      }
                    >
                      {copy.history}
                    </button>
                  )}
                </div>
                {runs[item.id]?.length === 0 && <p>{copy.noRuns}</p>}
                {runs[item.id]?.map((run, index) => (
                  <p key={index}>
                    {formatTimestamp(run.runAtMs)} ·{" "}
                    {copy.states[run.completionStatus] ||
                      copy.states[run.status] ||
                      copy.states.unknown}
                  </p>
                ))}
              </div>
            )}
          </React.Fragment>
        ))}
      </ListCard>
    </section>
  );
}
