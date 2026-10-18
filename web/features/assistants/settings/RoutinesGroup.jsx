import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { routineCopy as copy } from "../../../lib/i18n/messages/assistant-routines.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { routineApi } from "../routine-api.js";

function scheduleLabel(trigger) {
  if (trigger?.kind === "event")
    return trigger.eventKind === "coding.completed" ? copy.codingCompleted : copy.manual;
  if (trigger?.kind === "at") return formatTimestamp(trigger.at);
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trigger?.expr || "");
  return daily
    ? copy.dailyAt(
        `${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")}`,
        trigger.tz,
      )
    : copy.scheduled;
}
const stateOf = (item) =>
  copy.states[
    item.status === "ready" ? (item.enabled ? "active" : "paused") : item.status
  ] || copy.states.unknown;

/**
 * Routines whose results go to the agent's chat with a push notification, and to a
 * `paired` Telegram chat where switched on; every action applies at once.
 */
export default function RoutinesGroup({ assistantId, paired = false }) {
  const id = useId();
  const [items, setItems] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [open, setOpen] = useState(null),
    [events, setEvents] = useState({});
  const [name, setName] = useState(""),
    [prompt, setPrompt] = useState(""),
    [trigger, setTrigger] = useState("daily"),
    [eventKind, setEventKind] = useState("manual"),
    [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [telegram, setTelegram] = useState(false);
  const alive = useRef(true),
    generation = useRef(0),
    identity = useRef(crypto.randomUUID()),
    eventIds = useRef(new Map());
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const result = await routineApi.list(assistantId);
    if (alive.current && request === generation.current) setItems(result.routines || []);
  }, [assistantId]);
  useEffect(() => {
    alive.current = true;
    refresh().catch((e) => {
      if (alive.current) setError(e.message);
    });
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  async function act(operation) {
    if (busy) return false;
    ++generation.current;
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
      const [hours, minutes] = time.split(":").map(Number);
      if (
        trigger === "daily" &&
        (!Number.isInteger(hours) ||
          !Number.isInteger(minutes) ||
          hours > 23 ||
          minutes > 59)
      )
        throw Error(copy.invalidTime);
      await routineApi.create(assistantId, {
        clientRequestId: identity.current,
        name,
        prompt,
        trigger:
          trigger === "event"
            ? { kind: "event", eventKind }
            : { kind: "cron", expr: `${minutes} ${hours} * * *`, tz: timezone },
        ...(paired && telegram ? { telegram: true } : {}),
      });
      if (alive.current) {
        setName("");
        setPrompt("");
        identity.current = crypto.randomUUID();
      }
    });
    if (done && alive.current) setCreating(false);
  }
  async function run(item) {
    const eventId = eventIds.current.get(item.id) || crypto.randomUUID();
    eventIds.current.set(item.id, eventId);
    const receipt = await routineApi.trigger(assistantId, item.id, { eventId });
    if (receipt.status !== "unknown") eventIds.current.delete(item.id);
    if (alive.current) setEvents((old) => ({ ...old, [item.id]: receipt.status }));
  }
  return (
    <section id="agent-routines" aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={copy.description}
        action={{
          label: settingsCopy.addRoutine,
          onClick: () => setCreating((value) => !value),
          disabled: busy,
        }}
      >
        {copy.title}
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
            {copy.name}
            <input
              required
              disabled={busy}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="agent-field">
            {copy.prompt}
            <textarea
              required
              disabled={busy}
              maxLength={8192}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <label className="agent-field">
            {copy.trigger}
            <select
              disabled={busy}
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            >
              <option value="daily">{copy.daily}</option>
              <option value="event">{copy.event}</option>
            </select>
          </label>
          {trigger === "event" ? (
            <label className="agent-field">
              {copy.eventKind}
              <select
                disabled={busy}
                value={eventKind}
                onChange={(e) => setEventKind(e.target.value)}
              >
                <option value="manual">{copy.manual}</option>
                <option value="coding.completed">{copy.codingCompleted}</option>
              </select>
            </label>
          ) : (
            <>
              <label className="agent-field">
                {copy.time}
                <input
                  type="time"
                  required
                  disabled={busy}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <label className="agent-field">
                {copy.timezone}
                <input
                  required
                  disabled={busy}
                  maxLength={100}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>
            </>
          )}
          {paired && (
            <ToggleRow
              label={copy.alsoTelegram}
              checked={telegram}
              disabled={busy}
              onChange={setTelegram}
            />
          )}
          <div className="agent-field assistant-actions">
            <button className="button primary" disabled={busy}>
              {copy.create}
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
        {!items.length && <p className="agent-row-note">{copy.empty}</p>}
        {items.map((item) => {
          const event = events[item.id] || item.lastEvent?.status;
          return (
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
                      {item.name || copy.unknownName}
                    </span>
                    <span className="list-row-sub">
                      <span>{stateOf(item)}</span>
                      <span className="agent-sub-part">
                        {scheduleLabel(item.trigger)}
                      </span>
                      {item.telegram && (
                        <span className="agent-sub-part">{copy.telegramOn}</span>
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
              {event && (
                <p role="status" className="agent-row-note">
                  {copy.events[event] || copy.events.unknown}
                </p>
              )}
              {open === item.id && (
                <div className="agent-detail" id={`${id}-detail-${item.id}`}>
                  <p>{item.prompt}</p>
                  {(paired || item.telegram) &&
                    ["ready", "unknown"].includes(item.status) && (
                      <ToggleRow
                        label={copy.alsoTelegram}
                        checked={item.telegram === true}
                        disabled={busy || (!paired && !item.telegram)}
                        onChange={(next) =>
                          act(() =>
                            routineApi.update(assistantId, item.id, {
                              telegram: next,
                              revision: item.revision,
                            }),
                          )
                        }
                      />
                    )}
                  <div className="assistant-actions">
                    {["ready", "unknown"].includes(item.status) && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            routineApi.update(assistantId, item.id, {
                              enabled: !item.enabled,
                              revision: item.revision,
                            }),
                          )
                        }
                      >
                        {item.enabled ? copy.pause : copy.resume}
                      </button>
                    )}
                    {item.trigger?.kind === "event" && (
                      <button
                        className="button secondary"
                        disabled={busy || !item.enabled || event === "unknown"}
                        onClick={() => act(() => run(item))}
                      >
                        {copy.run}
                      </button>
                    )}
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => act(() => routineApi.remove(assistantId, item.id))}
                    >
                      {copy.remove}
                    </button>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </ListCard>
    </section>
  );
}
