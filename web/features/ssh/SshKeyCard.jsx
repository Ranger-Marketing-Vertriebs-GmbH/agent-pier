import React, { useState } from "react";
import api, { apiError } from "../../lib/api.js";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
export default function SshKeyCard({ sshKey, project, edited, removed }) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inUse = sshKey.hosts.length > 0;
  return (
    <article className="ssh-card">
      <h3>{sshKey.name}</h3>
      <p className="ssh-owner-badge">
        {projectCopy.owner}: {project?.name || projectCopy.global}
      </p>
      <details className="ssh-detail-section">
        <summary>{copy.keyFingerprint}</summary>
        <code className="ssh-fingerprint">{sshKey.fingerprint}</code>
      </details>
      <SshCopy label={copy.publicKey} text={sshKey.publicKey} button={copy.copyKey} />
      <p>{copy.publicKeyHint}</p>
      <p>{projectCopy.downloadHint}</p>
      <p>
        {inUse
          ? `${copy.keyInUse}: ${sshKey.hosts.map((host) => host.name).join(", ")}`
          : copy.keyUnused}
      </p>
      <div className="ssh-actions">
        <button className="button" disabled={busy} onClick={() => edited(sshKey)}>
          {copy.edit}
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const response = await fetch(
                `/api/ssh-keys/${encodeURIComponent(sshKey.id)}/download`,
                { method: "POST" },
              );
              if (!response.ok) throw await apiError(response);
              const blobUrl = URL.createObjectURL(await response.blob());
              const link = document.createElement("a");
              link.href = blobUrl;
              link.download = `agentpier-${sshKey.id}.key`;
              document.body.append(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {projectCopy.download}
        </button>
        <button
          className="button"
          disabled={busy || inUse}
          onClick={() => setConfirm(true)}
        >
          {copy.remove}
        </button>
      </div>
      {confirm && (
        <div className="ssh-confirm">
          <p>{copy.keyDeleteHint}</p>
          <div className="ssh-actions">
            <button className="button" disabled={busy} onClick={() => setConfirm(false)}>
              {copy.cancel}
            </button>
            <button
              className="button"
              disabled={busy || inUse}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api(`/ssh-keys/${encodeURIComponent(sshKey.id)}`, "DELETE");
                  removed(sshKey.id);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {copy.confirmDelete}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{copy.busy}</p>}
    </article>
  );
}
