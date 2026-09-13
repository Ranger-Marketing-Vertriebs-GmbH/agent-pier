import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";

export default function FileConflictDialog({ job, scopeId, jobs }) {
  const [apply, setApply] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const conflict = job.conflict;
  const decide = async (decision) => {
    if (pending) return;
    setPending(true);
    try {
      if (decision === "cancel") await jobs.cancel(scopeId, job.id);
      else
        await jobs.resolve(scopeId, job.id, {
          conflictId: conflict.id,
          decision,
          applyToRemaining: ["copy", "move"].includes(job.kind) && apply,
        });
    } catch (issue) {
      setError(issue);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      className="file-action-dialog"
      title={copy.actions.conflict}
      close={() => decide("cancel")}
      closeDisabled={pending}
    >
      <p>{conflict.source}</p>
      <p>{conflict.target}</p>
      {conflict.sourceType && (
        <p>
          {copy.types[conflict.sourceType]} → {copy.types[conflict.targetType]}
        </p>
      )}
      {conflict.choices.includes("merge") && (
        <p>{copy.errors.FILE_MERGE_METADATA_RETAINED}</p>
      )}
      {job.kind === "restore" && conflict.sourceType === "directory" && (
        <p>{copy.actions.restoreDirectory}</p>
      )}
      {["copy", "move"].includes(job.kind) && (
        <label>
          <input
            type="checkbox"
            checked={apply}
            onChange={(event) => setApply(event.target.checked)}
          />
          {copy.actions.applyRemaining}
        </label>
      )}
      <ErrorMessage error={error?.message} />
      <div className="file-action-buttons">
        {conflict.choices.map((choice) => (
          <button
            className="button secondary"
            key={choice}
            disabled={pending}
            onClick={() => decide(choice)}
          >
            {copy.actions.choices[choice]}
          </button>
        ))}
      </div>
    </Modal>
  );
}
