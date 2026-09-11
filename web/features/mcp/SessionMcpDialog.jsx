import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import api from "../../lib/api.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
export default function SessionMcpDialog({ session, close }) {
  const [revoked, setRevoked] = useState(
    !session.agentpierTools?.enabled || session.status !== "running",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const grant = session.agentpierTools;
  return (
    <Modal title={copy.sessionTools} close={close}>
      <p>{copy.sessionToolsHint}</p>
      <p>
        {revoked
          ? copy.revoked
          : grant.expiresAt <= Date.now()
            ? copy.expired
            : copy.active}
      </p>
      <p>
        {copy.expires}: {formatTimestamp(grant.expiresAt)}
      </p>
      <ul>
        {grant.selection.scopes.map((scope) => (
          <li key={scope}>{copy.scopeLabels[scope]}</li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="button"
        disabled={busy || revoked}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api(`/sessions/${encodeURIComponent(session.id)}/mcp`, "DELETE");
            setRevoked(true);
          } catch (cause) {
            setError(cause.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {copy.revoke}
      </button>
    </Modal>
  );
}
