import React, { useEffect, useState } from "react";
import useResource from "../../lib/useResource.js";
import api from "../../lib/api.js";
import ConfirmOperation from "./ConfirmOperation.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

export default function ReleaseCleanup({ busy, job, navigate }) {
  const resource = useResource("/operations/releases/cleanup");
  const [selection, setSelection] = useState(null);
  const { refresh } = resource;
  const jobId = job?.id,
    jobStatus = job?.status;
  useEffect(() => {
    if (jobId && jobStatus !== "running") refresh();
  }, [jobId, jobStatus, refresh]);
  const versions =
    resource.data?.versions.filter((item) => item.deleteReason !== "active") || [];
  const removable = versions.filter((item) => item.canDelete).map((item) => item.version);
  return (
    <details className="operations-card">
      <summary>{copy.cleanupReleases}</summary>
      <p>{copy.cleanupHelp}</p>
      {(resource.error || resource.data?.available === false) && (
        <p>{copy.cleanupUnavailable}</p>
      )}
      <button
        className="button secondary"
        disabled={busy || !removable.length}
        onClick={() => setSelection(removable)}
      >
        {copy.cleanupAll}
      </button>
      {versions.map((item) => (
        <div className="operations-actions" key={item.version}>
          <strong>{item.version}</strong>
          {item.deleteReason && <span>{copy.cleanupReasons[item.deleteReason]}</span>}
          <button
            className="button secondary"
            disabled={busy || !item.canDelete}
            aria-label={`${copy.cleanupOne}: ${item.version}`}
            onClick={() => setSelection([item.version])}
          >
            {copy.cleanupOne}
          </button>
        </div>
      ))}
      {selection && (
        <ConfirmOperation
          description={copy.cleanupConfirm(selection.join(", "))}
          close={() => setSelection(null)}
          action={async () => {
            const result = await api("/operations/releases/cleanup", "POST", {
              versions: selection,
            });
            setSelection(null);
            navigate({ operationId: result.job.id });
          }}
        />
      )}
    </details>
  );
}
