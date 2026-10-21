import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import Sheet from "../../components/Sheet.jsx";
import { locale } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { notificationCopy as copy } from "../../lib/i18n/messages/notifications.js";
import { serverText } from "../../lib/server-messages.js";
import { deviceDisplayName, formatDeviceTime } from "./device-labels.js";
import NotificationPreferences from "./NotificationPreferences.jsx";

function deviceTimes(entry) {
  // The registration always names its day; a delivery today needs only the time.
  return [
    entry.createdAt &&
      copy.registeredAt(formatDeviceTime(entry.createdAt, { locale, date: true })),
    entry.lastSuccessAt &&
      copy.deliveredAt(formatDeviceTime(entry.lastSuccessAt, { locale })),
  ]
    .filter(Boolean)
    .join(" · ");
}

function DeviceRow({ entry, name, current, busy, error, onRemove, onSettings }) {
  return (
    <div
      className="list-row two-line notification-device"
      data-device-id={entry.id}
      aria-label={name}
      role="group"
    >
      <div className="list-row-main">
        <span className="list-row-text">
          <span className="list-row-label notification-device-name">
            <span>{name}</span>
            {current && <span className="list-row-pill">{copy.thisDevice}</span>}
          </span>
          <span className="list-row-sub">{deviceTimes(entry)}</span>
          {entry.lastFailure && (
            <span className="notification-device-failure">
              <span className="dot" aria-hidden="true" />
              {copy.lastFailure}: {serverText(entry.lastFailure)}
            </span>
          )}
          <ErrorMessage error={error} className="notification-device-error" />
        </span>
      </div>
      <button
        type="button"
        className="button secondary compact"
        aria-label={copy.deviceSettingsNamed(name)}
        disabled={busy}
        onClick={onSettings}
      >
        {copy.deviceSettings}
      </button>
      <button
        type="button"
        className="button secondary compact"
        aria-label={copy.removeNamed(name)}
        disabled={busy}
        onClick={onRemove}
      >
        {copy.remove}
      </button>
    </div>
  );
}

function DevicePreferences({ entry, state, name, onClose }) {
  const current = entry.deviceId === state.deviceId;
  return (
    <NotificationPreferences
      entry={entry}
      name={name}
      // Quiet hours count in the device's own time zone; this device saves its current one.
      zone={current ? state.timeZone : entry.preferences?.timeZone}
      onSave={state.savePreferences}
      personal={state.personal}
      onClose={onClose}
    />
  );
}

// Registered devices; this browser's entry unregisters at once (as turning
// notifications off does), any other device after a confirmation.
export default function DeviceList({ state }) {
  const { resource, action } = state;
  const [pending, setPending] = useState(null);
  // The device whose notification settings are open.
  const [editing, setEditing] = useState(null);
  const subscriptions = resource.data?.subscriptions || [];
  const nameOf = (entry) =>
    deviceDisplayName(entry, {
      current: entry.deviceId === state.deviceId,
      derived: state.derivedName,
      unnamed: copy.unnamedDevice,
    });
  const confirm = async () => {
    const entry = pending;
    setPending(null);
    await state.remove(entry);
  };
  return (
    <>
      <GroupLabel id="notifications-devices">{copy.devices}</GroupLabel>
      <ListCard labelledBy="notifications-devices">
        {!resource.loading && !subscriptions.length && <ListRow label={copy.noDevices} />}
        {subscriptions.map((entry) => {
          const current = entry.deviceId === state.deviceId;
          return (
            <DeviceRow
              key={entry.id}
              entry={entry}
              name={nameOf(entry)}
              current={current}
              busy={action.busy}
              error={current ? "" : state.errorFor(entry.id)}
              onRemove={() => (current ? state.remove(entry) : setPending(entry))}
              onSettings={() => setEditing(entry.id)}
            />
          );
        })}
      </ListCard>
      {editing && subscriptions.some((entry) => entry.id === editing) && (
        <DevicePreferences
          entry={subscriptions.find((entry) => entry.id === editing)}
          state={state}
          name={nameOf(subscriptions.find((entry) => entry.id === editing))}
          onClose={() => setEditing(null)}
        />
      )}
      <Sheet
        open={Boolean(pending)}
        title={copy.removeTitle}
        onCancel={() => setPending(null)}
      >
        <p className="sheet-body">{pending && copy.removeConfirm(nameOf(pending))}</p>
        <div className="sheet-actions">
          <button type="button" className="button danger" onClick={confirm}>
            {copy.remove}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setPending(null)}
          >
            {commonCopy.cancel}
          </button>
        </div>
      </Sheet>
    </>
  );
}
