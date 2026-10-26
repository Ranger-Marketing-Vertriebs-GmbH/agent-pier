import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";

/**
 * The host key changed (the server's last test reported `hostKeyMismatch`): the
 * pinned fingerprint next to the one the host shows now, fetched on request. Only
 * an explicit, confirmed "Neuen Schlüssel übernehmen" pins the new key, through the
 * access's usual edit (PATCH with the scanned host key).
 */
export default function SshHostKeyChanged({ access, onAccepted }) {
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [kept, setKept] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const fetchKey = async () => {
    setBusy(true);
    setError("");
    try {
      setScan(
        await api("/ssh-accesses/scan", "POST", {
          host: access.host,
          port: Number(access.port),
        }),
      );
      setKept(false);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  if (accepted)
    return (
      <p className="connections-banner" role="status">
        {copy.hostKey.accepted}
      </p>
    );
  return (
    <section className="connections-banner is-error" aria-label={copy.hostKey.title}>
      <h3>{copy.hostKey.title}</h3>
      <p>{copy.hostKey.body}</p>
      <dl className="connections-fingerprints">
        <dt>{copy.hostKey.pinned}</dt>
        <dd>
          <code>{access.hostFingerprint}</code>
        </dd>
        {scan && (
          <>
            <dt>{copy.hostKey.now}</dt>
            <dd>
              <code>{scan.hostFingerprint}</code>
            </dd>
          </>
        )}
      </dl>
      <p className="accounts-note">{copy.hostKey.hint}</p>
      <ErrorMessage error={error} />
      <div className="connections-actions">
        {!scan || kept ? (
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={fetchKey}
          >
            {busy ? copy.hostKey.fetching : copy.hostKey.fetch}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button danger compact"
              onClick={() => setConfirming(true)}
            >
              {copy.hostKey.accept}
            </button>
            <button
              type="button"
              className="button secondary compact"
              onClick={() => setKept(true)}
            >
              {copy.hostKey.keepBlocked}
            </button>
          </>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          destructive
          title={copy.hostKey.acceptTitle(access.name)}
          body={copy.hostKey.acceptBody}
          confirmLabel={copy.hostKey.acceptNow}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            const saved = await api(
              `/ssh-accesses/${encodeURIComponent(access.id)}`,
              "PATCH",
              { hostKey: scan.hostKey },
            );
            setConfirming(false);
            setAccepted(true);
            onAccepted?.(saved);
          }}
        />
      )}
    </section>
  );
}
