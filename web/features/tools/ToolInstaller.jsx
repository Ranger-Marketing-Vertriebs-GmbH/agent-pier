import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { toolInstallerCopy as copy } from "../../lib/i18n/de/tools.js";
import React from "react";
import useToolInstallation from "./useToolInstallation.js";
const labels = {
  idle: commonCopy.installationReady,
  running: commonCopy.installationRunning,
  succeeded: commonCopy.installationSucceeded,
  failed: commonCopy.installationFailed,
};
export default function ToolInstaller({
  tool,
  request,
  refresh,
  close,
  launch,
  configure,
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
  });
  return (
    <div className="tool-installer">
      <div className="form-content tool-install-content">
        <p className="field-description">{copy.serverInstallationDescription}</p>
        {loading && (
          <p className="tool-install-note" role="status">
            {copy.installationPreparing}
          </p>
        )}
        {job && (
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
            <div
              className={`tool-install-status ${job.status}`}
              role="status"
              aria-live="polite"
            >
              <strong>{labels[job.status] || job.status}</strong>
              {job.message && <p>{job.message}</p>}
              {job.version && <code>{job.version}</code>}
            </div>
            {(running || submitting) && (
              <p className="tool-install-note">
                {copy.backgroundInstallationDescription}
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
            onClick={utility ? configure || close : launch}
          >
            {syncing
              ? copy.refreshingInstallationStatus
              : utility
                ? copy.githubCredentials
                : commonCopy.startSession}
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={loading || !job?.available || globalBusy || running || submitting}
            onClick={install}
          >
            {submitting
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
