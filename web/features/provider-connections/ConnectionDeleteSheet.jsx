import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import api from "../../lib/api.js";
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
  if (!open) return null;
  return (
    <ConfirmDialog
      destructive
      title={copy.deleteTitle(connection.name)}
      body={copy.deleteConfirm(connection.name, connection.hasSecret === true)}
      confirmLabel={confirmRestart ? copy.deleteAndRestart : copy.deleteNow}
      busy={busy}
      error={error}
      onCancel={close}
      onConfirm={remove}
    >
      {confirmRestart && <p role="status">{copy.restartRequired}</p>}
      {confirmRestart && <AffectedAgents affected={affected} />}
    </ConfirmDialog>
  );
}
