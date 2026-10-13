import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { SelectRow, ToggleRow } from "../../../components/ListRow.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantProactivityCopy as copy } from "../../../lib/i18n/messages/assistant-proactivity.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { browserTimeZone, heartbeatIntervals, heartbeatRuns } from "../heartbeat.js";

const hours = Array.from({ length: 25 }, (_, hour) => hour);
const hourOptions = (list) =>
  list.map((hour) => ({ value: String(hour), label: copy.hour(hour) }));

/**
 * Scheduled check-ins: they need saved memory and a connected Telegram chat; the extra
 * model runs are shown. A new agent switches them on after saving.
 */
export default function ProactivityGroup({
  assistant,
  values,
  set,
  connected = false,
  creating = false,
}) {
  const id = useId();
  const memory = assistant?.capabilities?.memory === true;
  const available = !creating && memory && connected;
  const saved = values.heartbeatEnabled === true;
  const on = available && saved;
  const sub = creating
    ? assistantCopy.personal.availableAfterSaving
    : !memory
      ? settingsCopy.heartbeatNeedsMemory
      : !connected
        ? copy.heartbeatChannel
        : undefined;
  // A saved zone stays until the owner adopts the browser's (after travelling).
  const zone = browserTimeZone();
  return (
    <section id="agent-proactivity" aria-labelledby={id}>
      <GroupLabel id={id} hint={`${copy.intro} ${copy.heartbeatDescription}`}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id} disabled={!creating && !available && !saved}>
        <ToggleRow
          label={copy.heartbeat}
          sub={sub}
          checked={!creating && saved}
          disabled={!available && !saved}
          onChange={(next) => set("heartbeatEnabled", next)}
        />
        {on && (
          <>
            <SelectRow
              label={copy.interval}
              value={values.interval}
              options={Object.keys(heartbeatIntervals).map((key) => ({
                value: key,
                label: copy.intervals[key],
              }))}
              onChange={(next) => set("interval", next)}
            />
            <SelectRow
              label={copy.activeFrom}
              value={String(values.start)}
              options={hourOptions(hours.slice(0, 24))}
              onChange={(next) => {
                const start = Number(next);
                set("start", start);
                if (values.end <= start) set("end", start + 1);
              }}
            />
            <SelectRow
              label={copy.activeUntil}
              value={String(values.end)}
              options={hourOptions(hours.slice(values.start + 1))}
              onChange={(next) => set("end", Number(next))}
            />
            <div className="agent-row-note">
              <p>{copy.heartbeatReply}</p>
              <p>
                {copy.timeZone(values.timeZone)}{" "}
                {copy.heartbeatCost(heartbeatRuns(values))}
              </p>
              {zone !== values.timeZone && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => set("timeZone", zone)}
                >
                  {copy.adoptZone(zone)}
                </button>
              )}
            </div>
          </>
        )}
      </ListCard>
    </section>
  );
}
