import React from "react";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
// Coding runs this team's members asked for, with the owner's exact decision and
// the resulting pipeline run.
export default function TeamCodingRequests({ actions, busy, onDecide }) {
  if (!actions.length) return null;
  return (
    <section className="assistant-team-coding" aria-label={copy.teamRequests}>
      <h4>{copy.teamRequests}</h4>
      {actions.map((a) => (
        <article className="assistant-card assistant-reminder-row" key={a.id}>
          <strong>{copy.requestedBy(a.memberName)}</strong>
          <p>
            {a.projectName}
            {a.pipelineName ? ` · ${a.pipelineName}` : ""}
          </p>
          <p className="assistant-memory-text">{a.payload.task}</p>
          {a.payload.baseBranch && (
            <p>
              {copy.branch}: {a.payload.baseBranch}
            </p>
          )}
          <p>{copy.states[a.state]}</p>
          {a.diagnostic && copy.diagnostics[a.diagnostic] && (
            <p className="assistant-note">{copy.diagnostics[a.diagnostic]}</p>
          )}
          {a.state === "awaiting_approval" && (
            <>
              <p className="assistant-note">{copy.memberApprovalHint}</p>
              <div className="assistant-actions">
                {["approve", "decline"].map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    disabled={busy}
                    className={`button ${decision === "approve" ? "primary" : "secondary"}`}
                    onClick={() => onDecide(a, decision)}
                  >
                    {copy[decision]}
                  </button>
                ))}
              </div>
            </>
          )}
          {a.run && (
            <p>
              {copy.runStatus}: {copy.runStates[a.run.status] || copy.states.unknown}
            </p>
          )}
          {a.run && (
            <a href={a.run.url} className="button secondary">
              {a.run.status === "awaiting-human" ? copy.humanGate : copy.openRun}
            </a>
          )}
        </article>
      ))}
    </section>
  );
}
