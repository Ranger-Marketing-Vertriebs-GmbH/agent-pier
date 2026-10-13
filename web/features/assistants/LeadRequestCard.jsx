import React from "react";
import { leadRequestCopy as copy } from "../../lib/i18n/messages/lead-requests.js";
import { assistantApi } from "./assistant-api.js";

const open = new Set(["queued", "dispatching", "running", "uncertain"]);
/** The state label; a finished question reads "Answered", a finished task "Done". */
export const requestState = (r) =>
  r.phase === "completed" && r.type === "question"
    ? copy.states.answered
    : copy.states[r.phase] || r.phase;

/**
 * A lead's question or task for one of its members. Waiting for the owner, it is
 * decided here (chat and Settings → Work → Teams); an open one can be cancelled.
 */
export default function LeadRequestCard({ request: r, busy, act }) {
  const pending = r.phase === "awaiting_approval";
  return (
    <article
      className="assistant-approval-card lead-request-card"
      data-pending={pending ? "" : undefined}
      aria-label={copy.title(r.type, r.memberName)}
    >
      <div className="assistant-approval-head">
        <strong>{copy.title(r.type, r.memberName)}</strong>
        <small>{requestState(r)}</small>
      </div>
      <p className="assistant-approval-task">{r.text}</p>
      {r.ownerRequestQuote && (
        <p className="assistant-note">{copy.because(r.ownerRequestQuote)}</p>
      )}
      {r.answer && (
        <details className="assistant-team-report">
          <summary>{r.type === "task" ? copy.result : copy.answer}</summary>
          <p>{r.answer}</p>
        </details>
      )}
      {pending && <p className="assistant-note">{copy.approvalHint}</p>}
      {(pending || open.has(r.phase)) && (
        <div className="assistant-card-actions">
          {pending ? (
            ["approve", "decline"].map((decision) => (
              <button
                key={decision}
                type="button"
                disabled={busy}
                className={`button ${decision === "approve" ? "primary" : "secondary"}`}
                onClick={() =>
                  act(() =>
                    assistantApi.decideLeadRequest(r.id, {
                      revision: r.revision,
                      decision,
                    }),
                  )
                }
              >
                {copy[decision]}
              </button>
            ))
          ) : (
            <button
              type="button"
              disabled={busy}
              className="button secondary"
              onClick={() => act(() => assistantApi.cancelLeadRequest(r.id))}
            >
              {copy.cancel}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
