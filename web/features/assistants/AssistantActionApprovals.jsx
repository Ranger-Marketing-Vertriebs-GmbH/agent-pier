import React, { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
import usePolling from "./usePolling.js";
import { useAssistantEvent } from "./useAssistants.js";
// The agent's own coding tasks and memory changes waiting for the owner, decided
// inline in the chat. Team members' requests open their team card instead;
// Settings keep the full history.
export default function AssistantActionApprovals({ assistantId }) {
  const [actions, setActions] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lastEvent = useAssistantEvent();
  const load = useCallback(
    async (signal) => {
      try {
        const r = await api(`/assistants/${encodeURIComponent(assistantId)}/actions`);
        if (!signal?.aborted)
          setActions(
            (r.actions || []).filter((a) => a.state === "awaiting_approval" && !a.teamId),
          );
      } catch {
        // The settings tab reports load failures; the chat keeps the last list.
      }
    },
    [assistantId],
  );
  useEffect(() => {
    if (!lastEvent || ["change", "connected"].includes(lastEvent.type)) load();
  }, [lastEvent, load]);
  // Approvals expire; while one waits, its state is refreshed.
  usePolling(load, 5000, {
    enabled: actions.length > 0,
    immediate: false,
    restartKey: load,
  });
  async function decide(a, decision) {
    setBusy(true);
    setError("");
    try {
      await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
        revision: a.revision,
        decision,
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!actions.length && !error) return null;
  return (
    <section className="assistant-action-approvals" aria-label={copy.pendingApprovals}>
      <h3>{copy.pendingApprovals}</h3>
      <ErrorMessage error={error} />
      {actions.map((a) => (
        <article className="assistant-card assistant-reminder-row" key={a.id}>
          <strong>
            {a.payload.action === "coding_start" ? copy.coding : copy.memory}
          </strong>
          <p>
            {a.projectName}
            {a.pipelineName ? ` · ${a.pipelineName}` : ""}
          </p>
          {a.payload.title && <strong>{a.payload.title}</strong>}
          <p className="assistant-memory-text">{a.payload.task || a.payload.content}</p>
          {a.payload.baseBranch && (
            <p>
              {copy.branch}: {a.payload.baseBranch}
            </p>
          )}
          <div className="assistant-actions">
            {["approve", "decline"].map((decision) => (
              <button
                key={decision}
                type="button"
                disabled={busy}
                className={`button ${decision === "approve" ? "primary" : "secondary"}`}
                onClick={() => decide(a, decision)}
              >
                {copy[decision]}
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
