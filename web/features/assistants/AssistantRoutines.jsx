import React, { useCallback, useEffect, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { routineCopy as copy } from "../../lib/i18n/messages/assistant-routines.js";
import { routineApi } from "./routine-api.js";
export default function AssistantRoutines({ assistantId }) {
  // A keyed form prevents responses from an old assistant overwriting a new one.
  return <RoutinePanel key={assistantId} assistantId={assistantId} />;
}
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
function RoutinePanel({ assistantId }) {
  const [items, setItems] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState(""),
    [prompt, setPrompt] = useState("");
  const [trigger, setTrigger] = useState("daily"),
    [eventKind, setEventKind] = useState("manual");
  const [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [events, setEvents] = useState({});
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
    if (busy) return;
    ++generation.current;
    setBusy(true);
    setError("");
    try {
      await operation();
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
      });
      if (alive.current) {
        setName("");
        setPrompt("");
        identity.current = crypto.randomUUID();
      }
    });
  }
  async function run(item) {
    const eventId = eventIds.current.get(item.id) || crypto.randomUUID();
    eventIds.current.set(item.id, eventId);
    const receipt = await routineApi.trigger(assistantId, item.id, { eventId });
    if (receipt.status !== "unknown") eventIds.current.delete(item.id);
    if (alive.current) setEvents((old) => ({ ...old, [item.id]: receipt.status }));
  }
  return (
    <section className="assistant-form assistant-personal-panel" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <p className="assistant-note">{copy.description}</p>
      <ErrorMessage error={error} />
      <form
        onSubmit={create}
        onChange={() => {
          identity.current = crypto.randomUUID();
        }}
      >
        <label>
          {copy.name}
          <input
            required
            disabled={busy}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
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
        <label>
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
          <label>
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
          <div className="assistant-model-fields">
            <label>
              {copy.time}
              <input
                type="time"
                required
                disabled={busy}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label>
              {copy.timezone}
              <input
                required
                disabled={busy}
                maxLength={100}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
          </div>
        )}
        <button className="button primary" disabled={busy}>
          {copy.create}
        </button>
      </form>
      {!items.length && <p className="assistant-note">{copy.empty}</p>}
      {items.map((item) => (
        <article key={item.id} className="assistant-card assistant-reminder-row">
          <h3>{item.name || copy.unknownName}</h3>
          <p>{item.prompt}</p>
          <p>
            {copy.states[
              item.status === "ready" ? (item.enabled ? "active" : "paused") : item.status
            ] || copy.states.unknown}
          </p>
          <p className="assistant-note">{scheduleLabel(item.trigger)}</p>
          {item.nextRunAtMs && (
            <p className="assistant-note">
              {copy.nextRun(formatTimestamp(item.nextRunAtMs))}
            </p>
          )}
          {(events[item.id] || item.lastEvent?.status) && (
            <p role="status">
              {copy.events[events[item.id] || item.lastEvent.status] ||
                copy.events.unknown}
            </p>
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
                disabled={
                  busy ||
                  !item.enabled ||
                  (events[item.id] || item.lastEvent?.status) === "unknown"
                }
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
        </article>
      ))}
    </section>
  );
}
