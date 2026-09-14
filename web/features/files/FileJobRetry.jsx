import React, { useEffect, useRef, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { requestId } from "./file-action-utils.js";

export default function FileJobRetry({ job, jobs, scope, onClose }) {
  const hasDestination =
    [
      "copy",
      "move",
      "extract",
      "restore",
      "rename",
      "create_file",
      "create_directory",
    ].includes(job.kind) ||
    (job.kind === "archive" && job.archiveOutput === "file");
  const [proposal, setProposal] = useState(null),
    [error, setError] = useState(null);
  const [pending, setPending] = useState(false),
    [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(200);
  const alive = useRef(true),
    attempt = useRef(null),
    busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    jobs
      .retryPreview(scope.scopeId, job.id, scope.limits.jobEntries)
      .then(
        (value) => {
          if (alive.current) setProposal(value);
        },
        (issue) => {
          if (alive.current) setError(issue);
        },
      )
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // This dialog belongs to the selected job and scope, not each polling snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = async () => {
    if (busy.current || !proposal) return;
    attempt.current ||= proposal.attempt || {
      requestId: requestId(),
      reference: proposal.reference,
    };
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await jobs.retryJob(scope.scopeId, job.id, attempt.current);
      if (alive.current) onClose();
    } catch (issue) {
      if (alive.current) setError(issue);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <Modal
      className="file-action-dialog"
      title={copy.transfers.retryTitle}
      close={() => {
        if (!pending) onClose();
      }}
      closeDisabled={pending}
    >
      <p>
        {copy.jobKinds[job.kind]} · {copy.transfers.retryPolicy}
      </p>
      {loading && <p role="status">{copy.transfers.loadingRetry}</p>}
      {proposal?.attempt && <p>{copy.transfers.sameAttempt}</p>}
      {proposal && (
        <>
          <p>{copy.transfers.retryCount(proposal.totalEntries)}</p>
          {job.kind === "purge" && (
            <p>{copy.actions.purgeConfirm(proposal.totalEntries, 0)}</p>
          )}
          <ul className="file-frozen-selection">
            {proposal.entries.slice(0, limit).map((row) => (
              <li key={row.id}>
                {row.source && <p>{copy.transfers.retrySource(row.source)}</p>}
                {hasDestination ? (
                  <p>{copy.actions.destination(row.path)}</p>
                ) : (
                  !row.source && <p>{row.path}</p>
                )}
              </li>
            ))}
          </ul>
          {job.kind === "archive" && job.archiveOutput === "download" && (
            <p>{copy.transfers.actions.download_zip}</p>
          )}
          {proposal.entries.length > limit && (
            <button
              className="button secondary compact"
              onClick={() => setLimit((value) => value + 200)}
            >
              {copy.actions.moreResults}
            </button>
          )}
        </>
      )}
      <ErrorMessage error={error?.message} />
      {attempt.current && error && <p>{copy.transfers.sameAttempt}</p>}
      <div className="file-action-buttons">
        <button
          className="button"
          disabled={
            loading ||
            pending ||
            !proposal ||
            (scope.readOnly &&
              !(job.kind === "archive" && job.archiveOutput === "download") &&
              !["search", "size"].includes(job.kind))
          }
          onClick={submit}
        >
          {copy.transfers.confirmRetry}
        </button>
        <button className="button secondary" disabled={pending} onClick={onClose}>
          {copy.actions.choices.cancel}
        </button>
      </div>
    </Modal>
  );
}
