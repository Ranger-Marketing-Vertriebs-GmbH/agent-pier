import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";
import { deviceRowView } from "./device-view.js";

export const devicesListSection = "devices-list";
// Reset and delete lose data: the quieter destructive style beside the others.
const styles = { start: "secondary", stop: "secondary" };

// One device: name, state and details, what its image or failure means, and its
// actions as buttons below, which wrap on a phone and keep their 44px targets.
function DeviceRow({ device, view, status, devices, bytes, ask }) {
  const [error, setError] = useState("");
  const shown = deviceRowView(device, {
    availability: view.availability,
    installation: status,
    bytes,
  });
  const waiting = (kind) => devices.pending.has(`${kind}:${device.id}`);
  // One request per device at a time: the server runs them one after another anyway.
  const busy = ["start", "stop", "reset", "delete"].some(waiting);
  const run = (kind) => {
    setError("");
    if (kind === "reset" || kind === "delete") return ask({ kind, device });
    return void devices[kind](device.id).catch((failure) => setError(failure.message));
  };
  const hints = [...new Set(shown.actions.map((action) => action.hint).filter(Boolean))];
  return (
    <div className="device-row" role="group" aria-label={device.name}>
      <ListRow
        label={device.name}
        sub={shown.sub}
        status={{ tone: shown.tone, text: shown.stateText }}
      />
      {shown.note && (
        <div className="devices-note">
          <p>{shown.note}</p>
        </div>
      )}
      {shown.alert && (
        <p role="alert" className="devices-alert">
          {shown.alert}
        </p>
      )}
      <div className="device-row-actions">
        {shown.actions.map((action) => (
          <button
            key={action.kind}
            type="button"
            className={`button compact ${styles[action.kind] ?? "destructive"}`}
            aria-label={action.name}
            disabled={action.disabled || busy}
            onClick={() => run(action.kind)}
          >
            {waiting(action.kind) ? commonCopy.pending : action.label}
          </button>
        ))}
        {/* Why a button is off, unless the note above already says it. */}
        {hints
          .filter((hint) => hint !== shown.note && hint !== shown.stateText)
          .map((hint) => (
            <p key={hint} className="device-row-hint">
              {hint}
            </p>
          ))}
      </div>
      <ErrorMessage error={error} />
    </div>
  );
}

/**
 * The devices group: one row per device and "New device". Reset and delete ask first;
 * their dialogs stay open with the busy state until the server is done (a running
 * device is stopped first, which can take half a minute).
 */
export default function DeviceRows({ view, status, devices, bytes, blocked, onCreate }) {
  const [asking, setAsking] = useState(null);
  const { list: text } = copy;
  const { settings, counts } = view;
  const empty = !view.availability.available
    ? view.availability.reason === "DEVICES_NOT_INSTALLED"
      ? text.emptyNotInstalled
      : text.emptyUnavailable
    : text.empty;
  const target = asking?.device;
  const dialog = asking && copy[`${asking.kind}Dialog`];
  return (
    <section id={devicesListSection} aria-labelledby="devices-list-label">
      <GroupLabel
        id="devices-list-label"
        action={{ label: text.add, onClick: onCreate, disabled: !!blocked }}
      >
        {text.group}
      </GroupLabel>
      {view.devices.length ? (
        <>
          <ListCard labelledBy="devices-list-label" className="devices-card">
            {view.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                view={view}
                status={status}
                devices={devices}
                bytes={bytes}
                ask={setAsking}
              />
            ))}
          </ListCard>
          <p className="field-description">
            {text.summary(
              counts.total,
              settings.maxDevices,
              counts.running,
              settings.maxRunning,
            )}
          </p>
        </>
      ) : (
        <p className="devices-empty">{empty}</p>
      )}
      {/* Why "New device" is off: the limit (the missing installation is said above). */}
      {blocked && view.availability.available && (
        <p className="field-description">{blocked}</p>
      )}
      {asking && (
        <ConfirmDialog
          title={dialog.title(target.name)}
          body={dialog.body}
          confirmLabel={dialog.confirm}
          destructive
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            await devices[asking.kind](target.id);
            setAsking(null);
          }}
        />
      )}
    </section>
  );
}
