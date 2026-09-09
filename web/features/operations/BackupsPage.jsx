import ImportedAgentBusHistory from "./ImportedAgentBusHistory.jsx";
import React, { useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination, usePagination } from "../../components/Pagination.jsx";
import { formatTimestamp, formatNumber } from "../../lib/i18n/index.js";
import OperationJob from "./OperationJob.jsx";
import BackupForm from "./BackupForm.jsx";
import RestoreForm from "./RestoreForm.jsx";
import ConfirmOperation from "./ConfirmOperation.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
export default function BackupsPage({ route, navigate }) {
  const resource = useResource("/operations/backups"),
    [dialog, setDialog] = useState(""),
    [removing, setRemoving] = useState(null),
    paging = usePagination(resource.data?.backups || []);
  const started = (job) => {
    setDialog("");
    navigate({ operationId: job.id });
  };
  return (
    <section>
      <h1>{copy.backups}</h1>
      <p className="field-description">{copy.backupPrivacy}</p>
      <div className="operations-actions">
        <button className="button primary" onClick={() => setDialog("create")}>
          {copy.createBackup}
        </button>
        <button className="button secondary" onClick={() => setDialog("restore")}>
          {copy.inspectArchive}
        </button>
        <button className="button secondary" onClick={resource.refresh}>
          {copy.refresh}
        </button>
      </div>
      <OperationJob id={route.operationId} onComplete={resource.refresh} />
      <ErrorMessage error={resource.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {paging.items.map((backup) => (
        <article className="operations-card" key={backup.id}>
          <h3>{formatTimestamp(backup.createdAt)}</h3>
          <p>
            {formatNumber(backup.bytes)} B ·{" "}
            {backup.includeHistory ? copy.includeHistory : ""} ·{" "}
            {backup.withCredentials ? copy.withCredentials : ""}
          </p>
          <div className="operations-actions">
            <a
              className="button secondary"
              href={`/api/operations/backups/${encodeURIComponent(backup.id)}/download`}
              download
            >
              {copy.download}
            </a>
            <button className="button secondary" onClick={() => setRemoving(backup.id)}>
              {copy.remove}
            </button>
          </div>
        </article>
      ))}
      {resource.data && !paging.total && <p>{copy.empty}</p>}
      <Pagination paging={paging} label={copy.backups} />
      <ImportedAgentBusHistory />
      {dialog === "create" && (
        <BackupForm close={() => setDialog("")} started={started} />
      )}{" "}
      {dialog === "restore" && (
        <RestoreForm close={() => setDialog("")} started={started} />
      )}{" "}
      {removing && (
        <ConfirmOperation
          description={copy.deleteBackup}
          close={() => setRemoving(null)}
          action={async () => {
            await api(`/operations/backups/${encodeURIComponent(removing)}`, "DELETE");
            setRemoving(null);
            resource.refresh();
          }}
        />
      )}
    </section>
  );
}
