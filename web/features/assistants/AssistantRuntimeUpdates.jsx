import React, { useState } from "react";
import api from "../../lib/api.js";
import { apiCopy } from "../../lib/i18n/messages/components.js";
import { locale } from "../../lib/i18n/index.js";
import { formatBytes } from "../../lib/format-bytes.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

const endpoint = "/assistant-runtime/updates";
const byteCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validProgress = (progress) =>
  progress == null ||
  (typeof progress === "object" &&
    byteCount(progress.copiedBytes) &&
    byteCount(progress.totalBytes));
function phaseText({ phase, snapshotProgress: progress }) {
  if (phase !== "snapshotting" || !progress) return copy.updates.phases[phase];
  return copy.updates.snapshotProgress(
    formatBytes(progress.copiedBytes, locale),
    formatBytes(progress.totalBytes, locale),
  );
}
// Whether `status` is an update status this panel can show.
function validStatus(status) {
  return !(
    !status ||
    !Object.hasOwn(copy.updates.phases, status.phase) ||
    !Array.isArray(status.blockers) ||
    ["currentVersion", "targetVersion"].some(
      (key) => status[key] !== null && typeof status[key] !== "string",
    ) ||
    !Number.isSafeInteger(status.affectedAssistants) ||
    status.affectedAssistants < 0 ||
    (status.affectedTeamMembers !== undefined &&
      (!Number.isSafeInteger(status.affectedTeamMembers) ||
        status.affectedTeamMembers < 0)) ||
    ["busy", "candidateReady", "recoveryRequired"].some(
      (key) => typeof status[key] !== "boolean",
    ) ||
    (status.updateAvailable !== undefined &&
      typeof status.updateAvailable !== "boolean") ||
    (status.diagnosticPath != null && typeof status.diagnosticPath !== "string") ||
    !validProgress(status.snapshotProgress)
  );
}
/**
 * The agent runtime's update status, following the live `runtime.updates` topic: the
 * server pushes every phase, busy change and snapshot progress.
 */
export default function AssistantRuntimeUpdates({ onChange }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const topic = useLiveTopic("runtime.updates");
  const { refresh } = topic;
  const valid = topic.data !== null && validStatus(topic.data);
  const status = valid ? topic.data : null;
  const readError =
    topic.error || (topic.data !== null && !valid ? apiCopy.requestFailed(503) : "");
  async function operate(action) {
    setBusy(true);
    setError("");
    try {
      await api(`${endpoint}/${action}`, "POST", {});
    } catch (e) {
      setError(e.message);
    } finally {
      try {
        await refresh();
        await onChange?.();
      } catch (e) {
        setError(e.message);
      }
      setBusy(false);
    }
  }
  const blocked = busy || status?.busy;
  const upToDate = status?.updateAvailable === false && !status.candidateReady;
  return (
    <section className="assistant-runtime-card">
      <h2>{copy.updates.title}</h2>
      <p className="assistant-note">{copy.updates.description}</p>
      <ErrorMessage error={error || readError} />
      {status && (
        <>
          <dl>
            <div>
              <dt>{copy.updates.current}</dt>
              <dd>{status.currentVersion || "—"}</dd>
            </div>
            <div>
              <dt>{copy.updates.target}</dt>
              <dd>{status.targetVersion || "—"}</dd>
            </div>
            <div>
              <dt>{copy.updates.phase}</dt>
              <dd>{phaseText(status)}</dd>
            </div>
          </dl>
          <p>
            {copy.updates.affected(status.affectedAssistants, status.affectedTeamMembers)}
          </p>
          {!!status.blockers.length && <p role="status">{copy.updates.blocked}</p>}
          {upToDate && <p role="status">{copy.updates.upToDate}</p>}
          {status.diagnostic && (
            <p role="status">{copy.updates.diagnostics[status.diagnostic]}</p>
          )}
          {status.diagnosticPath && (
            <p>
              <code>{status.diagnosticPath}</code>
            </p>
          )}
          <div className="assistant-actions">
            <button
              className="button secondary"
              disabled={blocked || status.recoveryRequired || upToDate}
              onClick={() => operate("stage")}
            >
              {copy.updates.stage}
            </button>
            <button
              className="button primary"
              disabled={
                blocked ||
                !status.candidateReady ||
                !status.currentVersion ||
                status.recoveryRequired
              }
              onClick={() => operate("activate")}
            >
              {copy.updates.activate}
            </button>
            {status.recoveryRequired && (
              <button
                className="button secondary"
                disabled={blocked}
                onClick={() => operate("recover")}
              >
                {copy.updates.recover}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
