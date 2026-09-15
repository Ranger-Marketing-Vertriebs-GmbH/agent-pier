import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy, fileErrorMessage } from "../../lib/i18n/messages/files.js";

export default function FileArchiveOmissions({ job, scopeId, jobs, maxEntries }) {
  const [manifest, setManifest] = useState(null),
    [error, setError] = useState(null);
  const [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false);
  const [limit, setLimit] = useState(200),
    [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true),
    busy = useRef(false);
  const load = async () => {
    setManifest(null);
    setConfirmed(false);
    setLoading(true);
    setError(null);
    try {
      const value = await jobs.loadOmissions(scopeId, job, maxEntries);
      if (alive.current) setManifest(value);
    } catch (issue) {
      if (alive.current) setError(issue);
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
    // A conflict ID and manifest generation own this mounted review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const decide = async (cancel = false) => {
    if (busy.current || (!cancel && (!manifest || !confirmed || loading))) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (cancel) await jobs.cancel(scopeId, job.id);
      else
        await jobs.resolve(scopeId, job.id, {
          conflictId: manifest.conflictId,
          decision: "skip_links",
          applyToRemaining: false,
        });
    } catch (issue) {
      if (alive.current) {
        setError(issue);
        setManifest(null);
        setConfirmed(false);
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <Modal
      className="file-action-dialog"
      title={copy.transfers.omissionsTitle}
      close={() => decide(true)}
      closeDisabled={pending}
    >
      <p>{copy.transfers.omissionsPolicy}</p>
      {loading && <p role="status">{copy.transfers.loadingOmissions}</p>}
      {manifest && (
        <>
          <p>{copy.transfers.omissionsCount(manifest.entries.length)}</p>
          <ul className="file-frozen-selection">
            {manifest.entries.slice(0, limit).map((row) => (
              <li key={row.id}>
                {row.path} · {copy.types[row.type]}
                {row.issue && <p>{fileErrorMessage(row.issue.code, 500)}</p>}
              </li>
            ))}
          </ul>
          {manifest.entries.length > limit && (
            <button
              className="button secondary compact"
              onClick={() => setLimit((value) => value + 200)}
            >
              {copy.actions.moreResults}
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {copy.transfers.omissionsConsent}
          </label>
        </>
      )}
      <ErrorMessage error={error?.message} />
      <div className="file-action-buttons">
        {!manifest && !loading && (
          <button className="button secondary" disabled={pending} onClick={load}>
            {copy.transfers.reloadOmissions}
          </button>
        )}
        <button
          className="button"
          disabled={loading || pending || !manifest || !confirmed}
          onClick={() => decide()}
        >
          {copy.transfers.continueOmissions}
        </button>
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => decide(true)}
        >
          {copy.actions.choices.cancel}
        </button>
      </div>
    </Modal>
  );
}
