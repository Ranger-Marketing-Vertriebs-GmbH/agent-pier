import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Sheet from "../../components/Sheet.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import AffectedAgents from "./AffectedAgents.jsx";
import { restartRequired } from "./restart-confirmation.js";

/** Deleting asks once; a connection agents use asks again to restart them. */
export default function ConnectionDeleteSheet({ connection, open, onClose, onDeleted }) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [affected, setAffected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    if (busy) return;
    setConfirmRestart(false);
    setAffected(null);
    setError("");
    onClose();
  };
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(
        `/provider-connections/${encodeURIComponent(connection.id)}`,
        "DELETE",
        confirmRestart ? { confirmRestart: true } : undefined,
      );
    } catch (failure) {
      setBusy(false);
      if (!restartRequired(failure)) return setError(failure.message);
      setConfirmRestart(true);
      setAffected(failure.affected);
      return undefined;
    }
    await onDeleted();
    return undefined;
  }
  return (
    <Sheet open={open} title={copy.delete} onCancel={close}>
      <p className="sheet-body">
        {copy.deleteConfirm(connection.name, connection.hasSecret === true)}
      </p>
      {confirmRestart && (
        <p className="sheet-body" role="status">
          {copy.restartRequired}
        </p>
      )}
      {confirmRestart && <AffectedAgents affected={affected} />}
      <ErrorMessage error={error} />
      <div className="sheet-actions">
        <button type="button" className="button danger" disabled={busy} onClick={remove}>
          {confirmRestart ? copy.deleteAndRestart : copy.delete}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          {commonCopy.cancel}
        </button>
      </div>
    </Sheet>
  );
}
