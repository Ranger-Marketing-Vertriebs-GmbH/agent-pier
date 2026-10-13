import React, { useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ReleaseCleanup from "./ReleaseCleanup.jsx";
import ReleaseNotes from "./ReleaseNotes.jsx";
import OperationJob from "./OperationJob.jsx";
import ConfirmOperation from "./ConfirmOperation.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import { releasePresentation } from "./release-presentation.js";
import { serverText } from "../../lib/server-messages.js";
const isPrerelease = (version) => typeof version === "string" && version.includes("-");
// Marks release candidates wherever a version can be installed or activated.
function PrereleaseBadge({ version }) {
  return isPrerelease(version) ? (
    <>
      {" "}
      <span className="badge release-badge">{copy.prerelease}</span>
    </>
  ) : null;
}
export default function UpdatesPage({ route, navigate }) {
  const resource = useResource("/operations/releases"),
    action = useAsyncAction(),
    [plan, setPlan] = useState(null),
    [confirm, setConfirm] = useState(null),
    [reloadSessions, setReloadSessions] = useState(false),
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
            <PrereleaseBadge version={releases.current} />
          </p>
          <div className="operations-form">
            <label htmlFor="update-channel">{copy.channel}</label>
            <select
              id="update-channel"
              value={
                releases.updateChannelManaged
                  ? "custom"
                  : releases.updateChannel || "stable"
              }
              disabled={
                jobPending ||
                action.busy ||
                releases.updateChannelManaged ||
                !releases.supported
              }
              aria-describedby="update-channel-help"
              onChange={(event) => {
                const updateChannel = event.target.value;
                action.run(async () => {
                  const result = await api("/operations/releases/channel", "PUT", {
                    updateChannel,
                  });
                  setPlan(null);
                  resource.update(result);
                });
              }}
            >
              <option value="stable">{copy.channelStable}</option>
              <option value="preview">{copy.channelPreview}</option>
              {releases.updateChannelManaged && (
                <option value="custom">{copy.channelCustom}</option>
              )}
            </select>
            <p className="field-description" id="update-channel-help">
              {releases.updateChannelManaged
                ? [
                    copy.channelManagedHelp,
                    releases.channel && copy.channelManagedSource(releases.channel),
                  ]
                    .filter(Boolean)
                    .join(" ")
                : releases.updateChannel === "preview"
                  ? copy.channelPreviewHelp
                  : presentation.staged.some((staged) => isPrerelease(staged.version))
                    ? `${copy.channelStableHelp} ${copy.stagedPrereleaseHelp}`
                    : copy.channelStableHelp}
            </p>
          </div>
          {(!releases.supported || !releases.installed) && (
            <p>{serverText(releases.reason) || copy.setupRequired}</p>
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
              <h2>
                {presentation.candidate.version}
                <PrereleaseBadge version={presentation.candidate.version} />
              </h2>
              <ReleaseNotes
                version={presentation.candidate.version}
                from={releases.current}
              />
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
                <PrereleaseBadge version={staged.version} />
              </h3>
              <ReleaseNotes version={staged.version} from={releases.current} />
              <button
                className="button primary"
                aria-label={`${copy.activateRelease}: ${staged.version}`}
                disabled={
                  jobPending || action.busy || !releases.installed || !releases.supported
                }
                onClick={() => {
                  setReloadSessions(false);
                  setConfirm({
                    kind: "activate",
                    stagedId: staged.id,
                    version: staged.version,
                  });
                }}
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
                  {release.reason && <p>{serverText(release.reason)}</p>}
                  <button
                    className="button secondary"
                    disabled={jobPending || action.busy || !release.canRollback}
                    onClick={() => {
                      setReloadSessions(false);
                      setConfirm({ kind: "rollback", version: release.version });
                    }}
                  >
                    {copy.rollback}
                  </button>
                </article>
              ))}
            </details>
          )}
        </>
      )}
      <ReleaseCleanup
        busy={jobPending || action.busy}
        job={observedJob}
        navigate={navigate}
      />
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
                ? {
                    stagedId: confirm.stagedId,
                    ...(reloadSessions ? { reloadSessions: true } : {}),
                  }
                : { version: confirm.version },
            )
          }
        >
          {confirm.kind === "activate" && (
            <div className="operations-form">
              <label>
                <input
                  type="checkbox"
                  checked={reloadSessions}
                  onChange={(event) => setReloadSessions(event.target.checked)}
                  aria-describedby="activate-reload-help"
                />{" "}
                {copy.activateReload}
              </label>
              <p className="field-description" id="activate-reload-help">
                {copy.activateReloadHelp}
              </p>
            </div>
          )}
        </ConfirmOperation>
      )}
    </section>
  );
}
