import React, { useState } from "react";
import api from "../../lib/api.js";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
export default function SshAccessDetails({
  access,
  project,
  edited,
  removed,
  loading,
  viewKey,
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tested, setTested] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    setTested(false);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="ssh-card">
      <h3>{access.name}</h3>
      <p className="ssh-owner-badge">
        {projectCopy.owner}: {project?.name || projectCopy.global}
      </p>
      <h4>{copy.connection}</h4>
      <dl className="ssh-connection-fields">
        <dt>{copy.host}</dt>
        <dd>{access.host}</dd>
        <dt>{copy.username}</dt>
        <dd>{access.username}</dd>
        <dt>{copy.port}</dt>
        <dd>{access.port}</dd>
      </dl>
      <div className="ssh-actions">
        <button
          className="button"
          disabled={busy || loading}
          onClick={() => edited(access)}
        >
          {copy.edit}
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api(`/ssh-accesses/${encodeURIComponent(access.id)}/test`, "POST");
              setTested(true);
            })
          }
        >
          {copy.test}
        </button>
      </div>
      <p className="ssh-action-hint">{copy.testHint}</p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{copy.busy}</p>}
      {tested && <p role="status">{copy.testOk}</p>}
      <div className="ssh-detail-section">
        <h4>{copy.keyMode}</h4>
        <div className="ssh-key-link">
          <span>{access.keyName}</span>
          <button
            className="ssh-text-button"
            disabled={loading}
            onClick={() => viewKey(access.keyId)}
          >
            {copy.viewKey}
          </button>
        </div>
        <SshCopy
          compact
          label={copy.publicKey}
          text={access.publicKey}
          button={copy.copyKey}
        />
        <p className="ssh-action-hint">{copy.publicKeyHint}</p>
      </div>
      <details className="ssh-detail-section">
        <summary>{copy.fingerprint}</summary>
        <code className="ssh-fingerprint">{access.hostFingerprint}</code>
      </details>
      <div className="ssh-detail-section">
        <button
          className="button ssh-delete"
          disabled={busy}
          onClick={() => setConfirm(true)}
        >
          {copy.remove}
        </button>
      </div>
      {confirm && (
        <div className="ssh-confirm">
          <p>{copy.deleteHint}</p>
          <div className="ssh-actions">
            <button className="button" disabled={busy} onClick={() => setConfirm(false)}>
              {copy.cancel}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/ssh-accesses/${encodeURIComponent(access.id)}`, "DELETE");
                  removed(access.id);
                })
              }
            >
              {copy.confirmDelete}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
