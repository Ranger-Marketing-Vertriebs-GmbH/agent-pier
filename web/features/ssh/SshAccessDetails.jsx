import React, { useState } from "react";
import api from "../../lib/api.js";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
export default function SshAccessDetails({
  access,
  project,
  edited,
  removed,
  loading,
  viewKey,
}) {
  const sftp = access.type === "sftp",
    usesKey = Boolean(access.keyId);
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tested, setTested] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    setTested(null);
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
      <h2>
        {access.name}
        {sftp && <span className="badge ssh-type-badge">{copy.sftpBadge}</span>}
      </h2>
      <p className="ssh-owner-badge">
        {projectCopy.owner}: {project?.name || projectCopy.global}
      </p>
      <h3>{copy.connection}</h3>
      <dl className="ssh-connection-fields">
        <dt>{copy.host}</dt>
        <dd>{access.host}</dd>
        <dt>{copy.username}</dt>
        <dd>{access.username}</dd>
        <dt>{copy.port}</dt>
        <dd>{access.port}</dd>
        {sftp && (
          <>
            <dt>{copy.remoteFolder}</dt>
            <dd>{access.remoteRoot || copy.noRemoteRoot}</dd>
          </>
        )}
        {!sftp && (
          <>
            <dt>{copy.legacyAlgorithms}</dt>
            <dd>{access.legacyAlgorithms ? copy.legacyOn : copy.legacyOff}</dd>
            <dt>{copy.interactiveShell}</dt>
            <dd>{access.interactiveShell ? copy.legacyOn : copy.legacyOff}</dd>
          </>
        )}
      </dl>
      {!sftp && access.legacyAlgorithms && (
        <p className="ssh-legacy-warning">{copy.legacyAlgorithmsWarning}</p>
      )}
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
              setTested(
                await api(`/ssh-accesses/${encodeURIComponent(access.id)}/test`, "POST"),
              );
            })
          }
        >
          {copy.test}
        </button>
      </div>
      <p className="ssh-action-hint">{sftp ? copy.sftpTestHint : copy.testHint}</p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{copy.busy}</p>}
      {tested && (
        <p role="status">{tested.commandRejected ? copy.testRejected : copy.testOk}</p>
      )}
      <div className="ssh-detail-section">
        <h3>{sftp ? copy.signIn : copy.keyMode}</h3>
        {sftp && !usesKey && <p>{copy.signInPassword}</p>}
        {usesKey && access.keyMissing && <p role="status">{copy.keyMissing}</p>}
        {usesKey && !access.keyMissing && (
          <>
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
          </>
        )}
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
          {commonCopy.delete}
        </button>
      </div>
      {confirm && (
        <div className="ssh-confirm">
          <p>{sftp ? copy.sftpDeleteHint : copy.deleteHint}</p>
          <div className="ssh-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              {commonCopy.cancel}
            </button>
            <button
              className="button danger"
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
