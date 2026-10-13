import React from "react";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
// Coding runs this team's members asked for, with the owner's exact decision and
// the resulting pipeline run. `title` names the team where several teams are listed.
export default function TeamCodingRequests({ id, title, actions, busy, onDecide }) {
  if (!actions.length) return null;
  const heading = title ? `${copy.teamRequests} · ${title}` : copy.teamRequests;
  return (
    <section id={id} className="assistant-team-coding" aria-label={heading}>
      <h4>{heading}</h4>
      {actions.map((a) => (
        <article
          className="assistant-approval-card"
          data-pending={a.state === "awaiting_approval" ? "" : undefined}
          key={a.id}
        >
          <div className="assistant-approval-head">
            <strong>{copy.requestedBy(a.memberName)}</strong>
            <small>{copy.states[a.state]}</small>
          </div>
          <p>
            {a.projectName}
            {a.pipelineName ? ` · ${a.pipelineName}` : ""}
          </p>
          <p className="assistant-approval-task">{a.payload.task}</p>
          {a.payload.baseBranch && (
            <p>
              {copy.branch}: {a.payload.baseBranch}
            </p>
          )}
          {a.diagnostic && copy.diagnostics[a.diagnostic] && (
            <p className="assistant-note">{copy.diagnostics[a.diagnostic]}</p>
          )}
          {a.state === "awaiting_approval" && (
            <>
              <p className="assistant-note">{copy.memberApprovalHint}</p>
              <div className="assistant-card-actions">
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
