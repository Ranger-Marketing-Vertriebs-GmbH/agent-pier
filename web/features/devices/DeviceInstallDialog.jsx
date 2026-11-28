import React from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";

/**
 * What installing downloads, from where, how large, and under which terms: the owner
 * accepts Google's terms with the confirming button, which sends `acceptTerms`.
 * `install()` rejects with the refusal in words; the dialog shows it and stays open.
 */
export default function DeviceInstallDialog({ status, bytes, install, close }) {
  const { pinned } = status;
  const { installDialog: text } = copy;
  return (
    <ConfirmDialog
      title={text.title}
      body={text.body(
        bytes(pinned.downloadBytes),
        bytes(pinned.diskBytes),
        status.sources.join(", "),
      )}
      confirmLabel={text.confirm}
      focusCancel
      onCancel={close}
      onConfirm={async () => {
        await install();
        close();
      }}
    >
      <ul className="devices-dialog-list" aria-label={text.componentsLabel}>
        <li>{text.emulator(pinned.emulator)}</li>
        <li>{text.platformTools(pinned.platformTools)}</li>
        <li>{text.image(pinned.image.api, pinned.image.abi ?? pinned.image.tag)}</li>
      </ul>
      <p>{text.terms}</p>
      <ul className="devices-dialog-list">
        {status.licences.map((licence) => (
          <li key={licence.id}>
            <a href={licence.url} target="_blank" rel="noopener noreferrer">
              {licence.name}
            </a>
          </li>
        ))}
      </ul>
      <p>{text.notRedistributed}</p>
    </ConfirmDialog>
  );
}
