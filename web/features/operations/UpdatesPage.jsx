import React, { useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ReleaseNotes from "./ReleaseNotes.jsx";
import OperationJob from "./OperationJob.jsx";
import ConfirmOperation from "./ConfirmOperation.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import { releasePresentation } from "./release-presentation.js";
export default function UpdatesPage({ route, navigate }) {
  const resource = useResource("/operations/releases"),
    action = useAsyncAction(),
    [plan, setPlan] = useState(null),
    [confirm, setConfirm] = useState(null),
    [observedJob, setObservedJob] = useState(null);
  const jobPending = Boolean(
    route.operationId &&
    (observedJob?.id !== route.operationId || observedJob.status === "running"),
  );
  const releases = resource.data;
  const presentation = releases ? releasePresentation(releases, plan) : null;
  const start = async (path, body) => {
    const result = await api("/operations/releases/" + path, "POST", body);
    setConfirm(null);
    navigate({ operationId: result.job.id });
  };
  return (
    <section>
      <h1>{copy.updates}</h1>
      <ErrorMessage error={resource.error || action.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {releases && (
        <>
          <p>
            {copy.currentVersion}: {releases.current || copy.unknown}
          </p>
          <p>
            {copy.channel}: {releases.channel || copy.unknown}
          </p>
          {(!releases.supported || !releases.installed) && (
            <p>{releases.reason || copy.setupRequired}</p>
          )}
          <button
            className="button secondary"
            disabled={jobPending || action.busy || !releases.supported}
            onClick={() =>
              action.run(async () =>
                setPlan((await api("/operations/releases/check", "POST", {})).plan),
              )
            }
          >
            {copy.checkUpdates}
          </button>
          {plan && !presentation.candidate && !presentation.staged.length && (
            <p>{copy.upToDate}</p>
          )}
          {presentation.candidate && (
            <article className="operations-card">
              <h2>{presentation.candidate.version}</h2>
              <ReleaseNotes version={presentation.candidate.version} />
              <p>
                {copy.platform}: {presentation.candidate.platform}
              </p>
              <p>
                {copy.integrity}: {presentation.candidate.sha256}
              </p>
              <p className="field-description">{copy.integrityHelp}</p>
              <button
                className="button primary"
                disabled={jobPending || action.busy}
                onClick={() =>
                  action.run(() =>
                    start("stage", { version: presentation.candidate.version }),
                  )
                }
              >
                {copy.stageRelease}
              </button>
            </article>
          )}
          {presentation.staged.map((staged) => (
            <article className="operations-card" key={staged.id}>
              <h3>
                {copy.staged}: {staged.version}
              </h3>
              <ReleaseNotes version={staged.version} />
              <button
                className="button primary"
                aria-label={`${copy.activateRelease}: ${staged.version}`}
                disabled={
                  jobPending || action.busy || !releases.installed || !releases.supported
                }
                onClick={() =>
                  setConfirm({
                    kind: "activate",
                    stagedId: staged.id,
                    version: staged.version,
                  })
                }
              >
                {copy.activateRelease}
              </button>
            </article>
          ))}
          {presentation.history.length > 0 && (
            <details>
              <summary>{copy.releaseHistory}</summary>
              {presentation.history.map((release) => (
                <article className="operations-card" key={release.version}>
                  <h3>{release.version}</h3>
                  {release.reason && <p>{release.reason}</p>}
                  <button
                    className="button secondary"
                    disabled={jobPending || action.busy || !release.canRollback}
                    onClick={() =>
                      setConfirm({ kind: "rollback", version: release.version })
                    }
                  >
                    {copy.rollback}
                  </button>
                </article>
              ))}
            </details>
          )}
        </>
      )}
      <OperationJob
        id={route.operationId}
        onComplete={resource.refresh}
        onState={setObservedJob}
      />
      {confirm && (
        <ConfirmOperation
          description={`${confirm.kind === "activate" ? copy.activateConfirmation : copy.rollbackConfirmation} ${confirm.version}`}
          close={() => setConfirm(null)}
          action={() =>
            start(
              confirm.kind,
              confirm.kind === "activate"
                ? { stagedId: confirm.stagedId }
                : { version: confirm.version },
            )
          }
        />
      )}
    </section>
  );
}
