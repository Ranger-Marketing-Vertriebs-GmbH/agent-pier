import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { toolInstallerCopy as copy } from "../../lib/i18n/messages/tools.js";
import React from "react";
import useToolInstallation from "./useToolInstallation.js";
const labels = {
  get idle() {
    return commonCopy.installationReady;
  },
  get running() {
    return commonCopy.installationRunning;
  },
  get succeeded() {
    return commonCopy.installationSucceeded;
  },
  get failed() {
    return commonCopy.installationFailed;
  },
};
export default function ToolInstaller({
  tool,
  request,
  refresh,
  close,
  launch,
  configure,
  update = false,
}) {
  const {
    loading,
    job,
    running,
    submitting,
    globalBusy,
    succeeded,
    loadError,
    error,
    syncError,
    syncing,
    synchronize,
    ready,
    utility,
    install,
  } = useToolInstallation({
    tool,
    request,
    refresh,
    close,
    launch,
    configure,
    update,
  });
  return (
    <div className="tool-installer">
      <div className="form-content tool-install-content">
        <p className="field-description">
          {update ? copy.updateDescription : copy.serverInstallationDescription}
        </p>
        {loading && (
          <p className="tool-install-note" role="status">
            {copy.installationPreparing}
          </p>
        )}
        {job && (
          <>
            {update && (
              <>
                <p>
                  <code>{job.updateCommand}</code>
                </p>
                {job.migrate && (
                  <p className="tool-install-note">{copy.migrationDescription}</p>
                )}
                {job.updateReason && (
                  <p className="tool-install-reason">{job.updateReason}</p>
                )}
              </>
            )}
            {!update && (
              <>
                <dl className="tool-install-details">
                  <div>
                    <dt>
                      {job.installer === "native-script"
                        ? copy.nativeInstaller
                        : job.installer === "github-release"
                          ? commonCopy.officialGithubRelease
                          : commonCopy.officialNpmPackage}
                    </dt>
                    <dd>
                      <code>
                        {job.installer === "native-script"
                          ? job.installerUrl
                          : job.packageName}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.toolInstallDetailsText}</dt>
                    <dd>
                      <code>{job.destination}</code>
                    </dd>
                  </div>
                </dl>
                <p className="tool-install-note">
                  {job.installer === "native-script"
                    ? copy.nativeInstallationDescription
                    : copy.isolatedInstallationDescription}
                </p>
                {job.reason && <p className="tool-install-reason">{job.reason}</p>}
              </>
            )}
            <div
              className={`tool-install-status ${job.status}`}
              role="status"
              aria-live="polite"
            >
              <strong>
                {update
                  ? running || submitting
                    ? copy.updating
                    : succeeded
                      ? copy.updated
                      : copy.updateReady
                  : labels[job.status] || job.status}
              </strong>
              {job.message && <p>{job.message}</p>}
              {job.version && <code>{job.version}</code>}
            </div>
            {(running || submitting) && (
              <p className="tool-install-note">
                {update
                  ? copy.backgroundUpdateDescription
                  : copy.backgroundInstallationDescription}
              </p>
            )}
            {globalBusy && !running && !succeeded && !submitting && (
              <p className="tool-install-reason">{copy.toolInstallReason}</p>
            )}
          </>
        )}
        {loadError && <ErrorMessage error={loadError} as="p" />}
        {error && <ErrorMessage error={error} as="p" />}
        {syncError && (
          <div>
            <ErrorMessage error={syncError} as="p" />
            <button
              type="button"
              className="button secondary compact"
              disabled={syncing}
              onClick={synchronize}
            >
              {copy.refreshInstallationStatus}
            </button>
          </div>
        )}
      </div>
      <div className="dialog-actions tool-install-actions">
        <button type="button" className="button secondary" onClick={close}>
          {commonCopy.close}
        </button>
        {succeeded ? (
          <button
            type="button"
            className="button primary"
            disabled={!ready || syncing}
            onClick={update ? close : utility ? configure || close : launch}
          >
            {syncing
              ? copy.refreshingInstallationStatus
              : update
                ? commonCopy.close
                : utility
                  ? copy.githubCredentials
                  : commonCopy.startSession}
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={
              loading ||
              !(update ? job?.updateAvailable : job?.available) ||
              globalBusy ||
              running ||
              submitting
            }
            onClick={install}
          >
            {update
              ? running || submitting
                ? copy.updating
                : job?.migrate
                  ? copy.migrateNow
                  : copy.updateNow
              : submitting
                ? copy.startingInstallation
                : running
                  ? commonCopy.installing
                  : job?.status === "failed"
                    ? copy.retryInstallation
                    : commonCopy.installNow}
          </button>
        )}
      </div>
    </div>
  );
}
