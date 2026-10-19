import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { CheckboxRow, RadioRow, ToggleRow } from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import useAsyncAction from "../../lib/useAsyncAction.js";

// The events a device chooses, grouped as the server's defaults are
// (server/features/notifications/push-preferences.js). System warnings always notify.
export const eventGroups = [
  [
    "waiting",
    ["question", "permission", "session-waiting", "pipeline-gate", "agent-approval"],
  ],
  [
    "finished",
    ["session-completed", "session-ended", "pipeline-completed", "pipeline-failed"],
  ],
  ["agents", ["agent-checkin", "agent-routine", "telegram"]],
];
const levels = ["type", "label", "preview"];

function TimeField({ label, value, onChange, disabled }) {
  return (
    <label className="notification-time">
      <span>{label}</span>
      <input
        type="time"
        value={value}
        required
        disabled={disabled}
        onChange={(event) => event.target.value && onChange(event.target.value)}
      />
    </label>
  );
}

/** One device's notification settings, saved together with Save. */
export default function NotificationPreferences({ entry, name, zone, onSave, onClose }) {
  const [draft, setDraft] = useState(entry.preferences);
  const { busy, error, run } = useAsyncAction();
  const setEvent = (key, value) =>
    setDraft((previous) => ({
      ...previous,
      events: { ...previous.events, [key]: value },
    }));
  const setQuiet = (patch) =>
    setDraft((previous) => ({ ...previous, quiet: { ...previous.quiet, ...patch } }));
  const save = () =>
    run(async () => {
      await onSave(entry, {
        level: draft.level,
        events: draft.events,
        grouping: draft.grouping,
        quiet: draft.quiet,
      });
      onClose();
    });
  return (
    <Modal
      title={copy.preferencesTitle(name)}
      close={onClose}
      closeDisabled={busy}
      className="notification-preferences"
      footer={
        <>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            {commonCopy.cancel}
          </button>
          <button type="button" className="button primary" disabled={busy} onClick={save}>
            {busy ? commonCopy.pending : commonCopy.save}
          </button>
        </>
      }
    >
      <GroupLabel id="notification-level" hint={copy.levelHint}>
        {copy.levelGroup}
      </GroupLabel>
      <ListCard labelledBy="notification-level">
        {levels.map((level) => (
          <RadioRow
            key={level}
            name={`notification-level-${entry.id}`}
            value={level}
            checked={draft.level === level}
            onChange={(value) => setDraft((previous) => ({ ...previous, level: value }))}
            label={copy.levels[level].label}
            sub={copy.levels[level].sub}
            disabled={busy}
          />
        ))}
      </ListCard>
      <GroupLabel id="notification-events" hint={copy.systemNote}>
        {copy.eventsGroup}
      </GroupLabel>
      {eventGroups.map(([group, keys]) => (
        <section className="notification-event-group" key={group}>
          <h3 id={`notification-events-${group}`}>{copy.eventGroups[group]}</h3>
          <ListCard labelledBy={`notification-events-${group}`}>
            {keys.map((key) => (
              <CheckboxRow
                key={key}
                label={copy.events[key]}
                sub={key === "telegram" ? copy.telegramSub : undefined}
                checked={Boolean(draft.events[key])}
                onChange={(value) => setEvent(key, value)}
                disabled={busy}
              />
            ))}
          </ListCard>
        </section>
      ))}
      <GroupLabel id="notification-behaviour" hint={copy.visibleNote}>
        {copy.behaviourGroup}
      </GroupLabel>
      <ListCard labelledBy="notification-behaviour">
        <ToggleRow
          label={copy.grouping}
          sub={copy.groupingSub}
          checked={draft.grouping}
          onChange={(value) => setDraft((previous) => ({ ...previous, grouping: value }))}
          disabled={busy}
        />
        <ToggleRow
          label={copy.quietHours}
          sub={copy.quietHoursSub(zone || copy.hostTimeZone)}
          checked={draft.quiet.enabled}
          onChange={(value) => setQuiet({ enabled: value })}
          disabled={busy}
        />
        {draft.quiet.enabled && (
          <>
            <div className="notification-quiet-times">
              <TimeField
                label={copy.quietFrom}
                value={draft.quiet.from}
                onChange={(from) => setQuiet({ from })}
                disabled={busy}
              />
              <TimeField
                label={copy.quietTo}
                value={draft.quiet.to}
                onChange={(to) => setQuiet({ to })}
                disabled={busy}
              />
            </div>
            <ToggleRow
              label={copy.blockingThrough}
              sub={copy.blockingThroughSub}
              checked={draft.quiet.blockingThrough}
              onChange={(value) => setQuiet({ blockingThrough: value })}
              disabled={busy}
            />
          </>
        )}
      </ListCard>
      <ErrorMessage error={error} />
    </Modal>
  );
}
