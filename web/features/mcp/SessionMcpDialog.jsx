import React, { useId, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import LearnMore from "../../components/LearnMore.jsx";
import PermissionList from "../../components/PermissionList.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import api from "../../lib/api.js";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
import { sessionReloadCopy } from "../../lib/i18n/messages/sessions.js";

// "active": the CLI holds a live grant. "revoked": the owner revoked it (or the
// session no longer runs). "regranted": granted again, back with the next reload.
function initialState(session) {
  const tools = session.agentpierTools;
  if (tools?.regranted) return "regranted";
  return tools?.enabled && session.status === "running" ? "active" : "revoked";
}

export default function SessionMcpDialog({ session, close, openReload }) {
  const [state, setState] = useState(() => initialState(session));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const grant = session.agentpierTools;
  const scopesId = useId();
  const path = `/sessions/${encodeURIComponent(session.id)}/mcp`;
  // Only an explicit revocation can be undone here; a stopped session keeps its
  // grant and gets it back when it resumes.
  const grantable = state === "revoked" && !grant.enabled;
  async function grantAgain() {
    setBusy(true);
    setError("");
    try {
      await api(path, "POST");
      setState("regranted");
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }
  if (confirming)
    return (
      <ConfirmDialog
        destructive
        title={copy.sessionRevokeTitle(session.name)}
        body={copy.sessionRevokeBody}
        confirmLabel={copy.confirmRevoke}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await api(path, "DELETE");
          setState("revoked");
          setConfirming(false);
        }}
      />
    );
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
          {state === "active" && (
            <button
              type="button"
              className="button destructive"
              onClick={() => setConfirming(true)}
            >
              {copy.revoke}
            </button>
          )}
          {grantable && (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={grantAgain}
            >
              {copy.grantAgain}
            </button>
          )}
          {state === "regranted" && openReload && (
            <button type="button" className="button primary" onClick={openReload}>
              {sessionReloadCopy.title}
            </button>
          )}
        </>
      }
    >
      <StatusChip tone={state === "active" ? "ok" : "neutral"} pill>
        {state === "active"
          ? copy.active
          : state === "regranted"
            ? copy.regranted
            : copy.revoked}
      </StatusChip>
      {state === "regranted" && (
        <p className="field-description" role="status">
          {copy.regrantedHint}
        </p>
      )}
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
