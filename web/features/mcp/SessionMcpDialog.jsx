import React, { useId, useState } from "react";
import Modal from "../../components/Modal.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import PermissionList from "../../components/PermissionList.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import api from "../../lib/api.js";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
export default function SessionMcpDialog({ session, close }) {
  const [revoked, setRevoked] = useState(
    !session.agentpierTools?.enabled || session.status !== "running",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const grant = session.agentpierTools;
  const scopesId = useId();
  return (
    <Modal
      title={copy.sessionTools}
      close={close}
      footer={
        <>
          {error && (
            <p className="dialog-actions-note error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="button destructive"
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
        </>
      }
    >
      <StatusChip tone={revoked ? "neutral" : "ok"} pill>
        {revoked ? copy.revoked : copy.active}
      </StatusChip>
      <LearnMore
        hint={
          grant.selection.allResources === true
            ? copy.sessionToolsSummary
            : copy.sessionToolsLimited
        }
      >
        <p>{copy.sessionToolsHint}</p>
      </LearnMore>
      <h3 id={scopesId} className="dialog-section-label">
        {copy.scopes}
      </h3>
      <PermissionList
        labelledBy={scopesId}
        items={grant.selection.scopes.map((scope) => [scope, copy.scopeLabels[scope]])}
      />
    </Modal>
  );
}
