import React, { useEffect } from "react";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
export default function OperationJob({ id, onComplete, onState }) {
  const resource = useResource(id ? `/operations/jobs/${encodeURIComponent(id)}` : null, {
      poll: 1500,
    }),
    job = resource.data?.job;
  useEffect(() => {
    if (job?.status === "succeeded") onComplete?.();
  }, [job?.id, job?.status, onComplete]);
  useEffect(() => {
    if (job?.id) onState?.({ id: job.id, status: job.status, kind: job.kind });
  }, [job?.id, job?.status, job?.kind, onState]);
  if (!id) return null;
  return (
    <section
      className={`operations-card ${job?.status === "failed" ? "operations-error" : ""}`}
      aria-label={copy.job}
    >
      <h2>{copy.job}</h2>
      <p className="field-description">{copy.jobHelp}</p>
      {resource.loading && <p role="status">{copy.loading}</p>}
      {resource.error && (
        <>
          <p role="status">{copy.reconnecting}</p>
          <ErrorMessage error={resource.error} />
        </>
      )}
      {job && (
        <>
          <p role="status">{copy.jobStatuses[job.status] || copy.unknown}</p>
          <ErrorMessage error={copy.cleanupErrors[job.errorCode] || job.error} />
          {job.result?.targetDataDir && (
            <>
              <h3>{copy.restored}</h3>
              <p>{job.result.targetDataDir}</p>
              <dl className="operations-metadata">
                {[
                  "credentialsRestored",
                  "credentialsNeedingLogin",
                  "importedSessions",
                  "importedRuns",
                ].map(
                  (key) =>
                    job.result[key] !== undefined && (
                      <React.Fragment key={key}>
                        <dt>
                          {key === "credentialsNeedingLogin"
                            ? copy.needsLogin
                            : copy[key]}
                        </dt>
                        <dd>
                          {Array.isArray(job.result[key])
                            ? job.result[key].join(", ")
                            : String(job.result[key])}
                        </dd>
                      </React.Fragment>
                    ),
                )}
              </dl>
            </>
          )}
          {job.status === "succeeded" && job.result?.activated === true && (
            <p>{copy.healthConfirmed}</p>
          )}
          {job.kind === "release-migrate" && job.status === "succeeded" && (
            <p>{copy.migrateSucceeded(job.result?.reloadedSessions?.length || 0)}</p>
          )}
          {job.result?.failedSessions?.length > 0 && (
            <>
              <h3>{copy.migrateFailedSessions}</h3>
              <ul>
                {job.result.failedSessions.map((item) => (
                  <li key={item.id}>
                    {item.id.slice(0, 8)}
                    {item.error ? `: ${item.error}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          {job.result?.remaining?.length > 0 && (
            <>
              <h3>{copy.migrateRemaining}</h3>
              <ul>
                {job.result.remaining.map((item, index) => (
                  <li key={`${item.reference}-${index}`}>{item.reference}</li>
                ))}
              </ul>
            </>
          )}
          {job.result?.rolledBack && <p>{copy.rolledBack}</p>}
          {job.result && (
            <details>
              <summary>{copy.details}</summary>
              <pre>{JSON.stringify(job.result, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
