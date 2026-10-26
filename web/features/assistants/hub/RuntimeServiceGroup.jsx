import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";
import PendingRestartNotice from "../PendingRestartNotice.jsx";
import useAssistants from "../useAssistants.js";

const transitions = ["installing", "starting", "stopping", "reconnecting"];
const tones = { ready: "ok", failed: "error", disabled: "idle" };
export const serviceTone = (availability) => tones[availability] ?? "pending";

/** Start, restart or stop the agent service; the shared list refreshes afterwards. */
export function useServiceAction() {
  const { refresh } = useAssistants();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const operate = async (action) => {
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
  };
  return { operate, busy, error };
}

/**
 * Laufzeit › Agentendienst: the service and its synchronization, enable or restart
 * and stop (immediate actions), the pending restart, and its technical details.
 */
export default function RuntimeServiceGroup() {
  const { runtime, error: loadError } = useAssistants();
  const { operate, busy, error } = useServiceAction();
  const id = useId();
  const availability = runtime.availability;
  const ready = availability === "ready";
  return (
    <section aria-labelledby={id} className="agents-runtime-service">
      <GroupLabel id={id} hint={copy.runtimeDescription}>
        {agentsHubCopy.runtime.service}
      </GroupLabel>
      <ErrorMessage error={error || loadError} />
      <PendingRestartNotice />
      {copy.runtimeDiagnostics?.[runtime.diagnostic] && (
        <p role="status" className="assistant-notice">
          {copy.runtimeDiagnostics[runtime.diagnostic]}
        </p>
      )}
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.serviceState}
          icon={<StatusDot tone={serviceTone(availability)} />}
          sub={copy.status[availability] ?? availability}
        >
          <div className="agents-hub-row-actions">
            <button
              type="button"
              className="button secondary compact"
              disabled={busy || transitions.includes(availability)}
              onClick={() => operate(ready ? "restart" : "enable")}
            >
              {ready ? copy.restart : copy.enable}
            </button>
            {availability !== "disabled" && (
              <button
                type="button"
                className="button destructive compact"
                disabled={busy}
                onClick={() => operate("stop")}
              >
                {copy.stopService}
              </button>
            )}
          </div>
        </ListRow>
        <ListRow label={copy.syncState} value={copy.status[runtime.sync]} />
        <details className="agents-runtime-details">
          <summary className="list-row">
            <span className="list-row-label">{copy.details}</span>
          </summary>
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
      </ListCard>
    </section>
  );
}
