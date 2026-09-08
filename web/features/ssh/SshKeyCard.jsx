import React, { useState } from "react";
import api from "../../lib/api.js";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
export default function SshKeyCard({ sshKey, edited, removed }) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inUse = sshKey.hosts.length > 0;
  return (
    <article className="ssh-card">
      <h3>{sshKey.name}</h3>
      <p>
        {copy.keyFingerprint}:{" "}
        <code className="ssh-fingerprint">{sshKey.fingerprint}</code>
      </p>
      <SshCopy label={copy.publicKey} text={sshKey.publicKey} button={copy.copyKey} />
      <p>{copy.publicKeyHint}</p>
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
