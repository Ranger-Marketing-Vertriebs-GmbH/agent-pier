import AssistantTeamSettings from "./AssistantTeamSettings.jsx";
import AssistantRuntimeUpdates from "./AssistantRuntimeUpdates.jsx";
import React, { useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
import useAssistants from "./useAssistants.js";
export default function AssistantRuntimeSettings() {
  const { runtime, refresh, error: loadError } = useAssistants();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function operate(action) {
    setBusy(true);
    setError("");
    try {
      await assistantApi.operate(action);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const transitioning = ["installing", "starting", "stopping", "reconnecting"].includes(
    runtime.availability,
  );
  return (
    <div className="page assistants-page">
      <header className="assistant-heading">
        <div>
          <p className="eyebrow">{copy.settings}</p>
          <h1>{copy.runtime}</h1>
          <p className="assistant-note">{copy.runtimeDescription}</p>
        </div>
      </header>
      <ErrorMessage error={error || loadError} />
      <section className="assistant-runtime-card">
        {copy.runtimeDiagnostics[runtime.diagnostic] && (
          <p role="status" className="assistant-notice">
            {copy.runtimeDiagnostics[runtime.diagnostic]}
          </p>
        )}
        <dl>
          <div>
            <dt>{copy.serviceState}</dt>
            <dd>
              <span className={`assistant-status ${runtime.availability}`}>
                {copy.status[runtime.availability]}
              </span>
            </dd>
          </div>
          <div>
            <dt>{copy.syncState}</dt>
            <dd>{copy.status[runtime.sync]}</dd>
          </div>
        </dl>
        <div className="assistant-actions">
          <button
            className="button primary"
            disabled={busy || transitioning}
            onClick={() =>
              operate(runtime.availability === "ready" ? "restart" : "enable")
            }
          >
            {runtime.availability === "ready" ? copy.restart : copy.enable}
          </button>
          {runtime.availability !== "disabled" && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => operate("stop")}
            >
              {copy.stopService}
            </button>
          )}
        </div>
        <details>
          <summary>{copy.details}</summary>
          <dl>
            <div>
              <dt>{copy.version}</dt>
              <dd>OpenClaw {runtime.version || "—"}</dd>
            </div>
            {runtime.diagnostic && (
              <div>
                <dt>{copy.diagnostic}</dt>
                <dd>
                  <code>{runtime.diagnostic}</code>
                </dd>
              </div>
            )}
          </dl>
        </details>
      </section>
      <AssistantRuntimeUpdates onChange={refresh} />
      <AssistantTeamSettings />
    </div>
  );
}
