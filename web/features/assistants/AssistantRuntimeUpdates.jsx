import React, { useState } from "react";
import api from "../../lib/api.js";
import { apiCopy } from "../../lib/i18n/messages/components.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import usePolling from "./usePolling.js";

const endpoint = "/assistant-runtime/updates";
async function loadStatus(signal) {
  const status = await api(endpoint, "GET", undefined, signal);
  if (
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
    (status.diagnosticPath != null && typeof status.diagnosticPath !== "string")
  )
    throw Error(apiCopy.requestFailed(503));
  return status;
}
export default function AssistantRuntimeUpdates({ onChange }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  usePolling(async (signal) => {
    try {
      setStatus(await loadStatus(signal));
    } catch (e) {
      if (!signal.aborted) {
        setStatus(null);
        setError(e.message);
      }
    }
  }, 2000);
  async function operate(action) {
    setBusy(true);
    setError("");
    try {
      await api(`${endpoint}/${action}`, "POST", {});
    } catch (e) {
      setError(e.message);
    } finally {
      try {
        setStatus(await loadStatus());
        await onChange?.();
      } catch (e) {
        setStatus(null);
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
      <ErrorMessage error={error} />
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
              <dd>{copy.updates.phases[status.phase]}</dd>
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
