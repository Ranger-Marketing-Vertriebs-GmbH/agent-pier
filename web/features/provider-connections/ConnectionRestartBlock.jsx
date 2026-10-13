import React from "react";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import AffectedAgents from "./AffectedAgents.jsx";

/** The save chain's restart question for a connection agents use, above the bar. */
export default function ConnectionRestartBlock({ confirmation }) {
  const focus = useAlertDialogFocus(confirmation.cancel);
  return (
    <div
      {...focus}
      className="accounts-confirmation"
      role="alertdialog"
      aria-label={copy.saveAndRestart}
    >
      <p role="status">{copy.restartRequired}</p>
      <AffectedAgents affected={confirmation.data?.affected} />
      <div className="accounts-confirmation-actions">
        <button type="button" className="button primary" onClick={confirmation.confirm}>
          {copy.saveAndRestart}
        </button>
        <button
          type="button"
          className="button secondary"
          data-autofocus
          onClick={confirmation.cancel}
        >
          {commonCopy.cancel}
        </button>
      </div>
    </div>
  );
}
