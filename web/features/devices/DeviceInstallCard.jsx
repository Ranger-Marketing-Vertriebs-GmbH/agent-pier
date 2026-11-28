import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";
import DeviceInstallDialog from "./DeviceInstallDialog.jsx";
import { installationView } from "./device-view.js";

export const devicesInstallationSection = "devices-installation";

/**
 * The installation group: its state, the running step with its byte counts, what is
 * installed, why the host cannot run devices or what failed, and the actions.
 * Installing (also a retry or an update) asks with the terms; uninstalling asks with
 * the number of devices it deletes; cancelling a download is cheap and asks nothing.
 */
export default function DeviceInstallCard({ status, view, devices, bytes }) {
  const [dialog, setDialog] = useState("");
  const [error, setError] = useState("");
  const shown = installationView(status, bytes, { running: view?.counts.running ?? 0 });
  const { installation: text } = copy;
  const count = view?.devices.length ?? 0;
  const busy = ["install", "cancel", "remove"].some((key) => devices.pending.has(key));
  const act = (kind) => {
    setError("");
    if (kind === "cancel")
      return void devices.cancel().catch((failure) => setError(failure.message));
    setDialog(kind === "remove" ? "remove" : "install");
  };
  return (
    <section id={devicesInstallationSection} aria-labelledby="devices-installation-label">
      <GroupLabel id="devices-installation-label">{text.group}</GroupLabel>
      <ListCard labelledBy="devices-installation-label">
        <ListRow
          label={text.label}
          sub={
            shown.versions ||
            text.description(
              bytes(status.pinned.downloadBytes),
              bytes(status.pinned.diskBytes),
            )
          }
          status={{ tone: shown.tone, text: shown.state }}
        />
        {shown.running && (
          <div className="devices-note" role="status">
            <p>{shown.progress}</p>
          </div>
        )}
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
        {shown.actions.map((action) => (
          <ListRow
            key={action.kind}
            label={action.label}
            sub={busy ? text.waitHint : action.hint}
            disabled={action.disabled || busy}
            onClick={() => act(action.kind)}
          />
        ))}
      </ListCard>
      <ErrorMessage error={error} />
      {dialog === "install" && (
        <DeviceInstallDialog
          status={status}
          bytes={bytes}
          install={devices.install}
          close={() => setDialog("")}
        />
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title={copy.removeDialog.title}
          body={count ? copy.removeDialog.body(count) : copy.removeDialog.bodyEmpty}
          confirmLabel={copy.removeDialog.confirm}
          destructive
          onCancel={() => setDialog("")}
          onConfirm={async () => {
            await devices.remove();
            setDialog("");
          }}
        />
      )}
    </section>
  );
}
