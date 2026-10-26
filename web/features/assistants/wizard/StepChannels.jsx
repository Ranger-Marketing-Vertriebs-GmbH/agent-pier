import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { SelectRow, ToggleRow } from "../../../components/ListRow.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantChannelCopy } from "../../../lib/i18n/messages/assistant-channel.js";
import { assistantProactivityCopy as proactivity } from "../../../lib/i18n/messages/assistant-proactivity.js";
import { assistantSettingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";
import { heartbeatIntervals } from "../heartbeat.js";
import ServiceSheet from "./ServiceSheet.jsx";

const copy = () => agentWizardCopy.channels;
const hours = Array.from({ length: 25 }, (_, hour) => hour);
const hourOptions = (list) =>
  list.map((hour) => ({ value: String(hour), label: proactivity.hour(hour) }));
export const newRoutine = () => ({
  name: "",
  prompt: "",
  time: "08:30",
});

// Voice messages need speech recognition: "hier einrichten" while it has no key.
function useSpeechMissing(wanted) {
  const [speech, setSpeech] = useState(null);
  const load = () =>
    assistantApi
      .speech()
      .then(setSpeech)
      .catch(() => {});
  useEffect(() => {
    if (wanted) load();
  }, [wanted]);
  return [Boolean(speech) && !speech.hasSecret, load];
}

/**
 * Schritt 5 (handoff 5.3): the Telegram bot token (connected on creation, paired
 * afterwards), "Sich von selbst melden" with how often and the active hours, one first
 * routine (name, description, daily time) and the hint that hooks come after
 * creating. A routine delivers to Telegram only once the bot is paired, which happens
 * after creating: the wizard says so instead of asking. An agent of users has none.
 */
export default function StepChannels({ d, set }) {
  const id = useId();
  const telegram = !d.owner && Boolean(d.telegramToken.trim());
  const [speechMissing, reloadSpeech] = useSpeechMissing(telegram);
  const [sheet, setSheet] = useState(false);
  if (d.owner)
    return (
      <p className="agent-locked-notice" role="note">
        {copy().userLocked}
      </p>
    );
  const routine = d.routine;
  const setRoutine = (patch) => set({ routine: { ...routine, ...patch } });
  return (
    <>
      <p className="field-description">{copy().intro}</p>
      <section aria-labelledby={`${id}-telegram`}>
        <GroupLabel id={`${id}-telegram`} hint={assistantChannelCopy.botHint}>
          {copy().telegram}
        </GroupLabel>
        <div className="list-card agent-fields">
          <label className="agent-field">
            {assistantChannelCopy.token}
            <input
              type="password"
              autoComplete="off"
              value={d.telegramToken}
              onChange={(event) => set({ telegramToken: event.target.value })}
            />
            <span className="field-description">{copy().tokenSub}</span>
          </label>
        </div>
        {telegram && speechMissing && (
          <button
            type="button"
            className="group-label-action agent-wizard-setup"
            onClick={() => setSheet(true)}
          >
            {assistantSettingsCopy.speechProvider}:{" "}
            {agentWizardCopy.capabilities.setUpHere}
          </button>
        )}
      </section>
      <section aria-labelledby={`${id}-checkins`}>
        <GroupLabel id={`${id}-checkins`} hint={proactivity.heartbeatDescription}>
          {proactivity.title}
        </GroupLabel>
        <ListCard labelledBy={`${id}-checkins`}>
          <ToggleRow
            label={copy().checkIns}
            sub={d.memory ? undefined : copy().checkInsSub}
            checked={d.heartbeatEnabled}
            disabled={!d.memory && !d.heartbeatEnabled}
            onChange={(heartbeatEnabled) => set({ heartbeatEnabled })}
          />
          {d.heartbeatEnabled && (
            <>
              <SelectRow
                label={proactivity.interval}
                value={d.heartbeatInterval}
                options={Object.keys(heartbeatIntervals).map((key) => ({
                  value: key,
                  label: proactivity.intervals[key],
                }))}
                onChange={(heartbeatInterval) => set({ heartbeatInterval })}
              />
              <SelectRow
                label={proactivity.activeFrom}
                value={String(d.heartbeatStart)}
                options={hourOptions(hours.slice(0, 24))}
                onChange={(next) => {
                  const start = Number(next);
                  set({
                    heartbeatStart: start,
                    ...(d.heartbeatEnd <= start ? { heartbeatEnd: start + 1 } : {}),
                  });
                }}
              />
              <SelectRow
                label={proactivity.activeUntil}
                value={String(d.heartbeatEnd)}
                options={hourOptions(hours.slice(d.heartbeatStart + 1))}
                onChange={(next) => set({ heartbeatEnd: Number(next) })}
              />
            </>
          )}
        </ListCard>
      </section>
      <section aria-labelledby={`${id}-routine`}>
        <GroupLabel id={`${id}-routine`}>{copy().routine}</GroupLabel>
        <ListCard labelledBy={`${id}-routine`}>
          <ToggleRow
            label={copy().routineOn}
            checked={Boolean(routine)}
            onChange={(on) =>
              set({
                routine: on ? newRoutine() : null,
                ...(on ? { reminders: true } : {}),
              })
            }
          />
        </ListCard>
        {routine && (
          <div className="list-card agent-fields">
            <label className="agent-field">
              {copy().routineName}
              <input
                maxLength={100}
                value={routine.name}
                onChange={(event) => setRoutine({ name: event.target.value })}
              />
            </label>
            <label className="agent-field">
              {copy().routineDescription}
              <textarea
                rows={3}
                value={routine.prompt}
                onChange={(event) => setRoutine({ prompt: event.target.value })}
              />
            </label>
            <label className="agent-field">
              {copy().routineTime}
              <input
                type="time"
                value={routine.time}
                onChange={(event) => setRoutine({ time: event.target.value })}
              />
            </label>
            {telegram && (
              <p className="field-description agent-field">
                {copy().routineTelegramLater}
              </p>
            )}
          </div>
        )}
      </section>
      <p className="field-description">{copy().hooks}</p>
      {sheet && (
        <ServiceSheet
          kind="speech"
          title={assistantCopy.speech.title}
          onClose={() => {
            setSheet(false);
            reloadSpeech();
          }}
        />
      )}
    </>
  );
}
