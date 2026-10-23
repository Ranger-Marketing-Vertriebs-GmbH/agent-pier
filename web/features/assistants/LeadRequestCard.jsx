import React, { useState } from "react";
import { leadRequestCopy as copy } from "../../lib/i18n/messages/lead-requests.js";
import { assistantApi } from "./assistant-api.js";
import RouteLink from "./RouteLink.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";

const open = new Set(["queued", "dispatching", "running", "uncertain"]);
/** A member's exchange with another member, its own report, or the lead's request. */
const titleOf = (r) =>
  r.fromName
    ? copy.peerTitle(r.type, r.fromName, r.memberName)
    : r.reportKind
      ? copy.reportTitle(r.reportKind, r.memberName)
      : copy.title(r.type, r.memberName);
/** The state label; a finished question reads "Answered", a finished task "Done". */
export const requestState = (r) =>
  r.phase === "completed" && r.type === "question"
    ? copy.states.answered
    : copy.states[r.phase] || r.phase;

/**
 * A lead's question or task for one of its members in Settings → Work → Teams. A
 * task says whether it may change files; an open request can be cancelled. Lists
 * carry a summary; the whole text and answer load on demand. An answer stored
 * incomplete links to the member's chat (`memberChat`, a route) where it is whole.
 */
export default function LeadRequestCard({
  request: summary,
  busy,
  act,
  memberChat,
  navigate,
}) {
  const [detail, setDetail] = useState(null);
  // The loaded detail is the whole request, never truncated.
  const r =
    detail && detail.revision === summary.revision
      ? { ...summary, ...detail, truncated: false }
      : summary;
  const load = async () => {
    if (detail?.revision === summary.revision) return;
    try {
      setDetail(await assistantApi.leadRequest(summary.id));
    } catch {
      /* The summary stays; a later open retries. */
    }
  };
  return (
    <article
      className="assistant-approval-card lead-request-card"
      aria-label={titleOf(r)}
    >
      <div className="assistant-approval-head">
        <strong>{titleOf(r)}</strong>
        {r.type === "task" && (
          <span className={`lead-request-access${r.writeAllowed ? " writes" : ""}`}>
            {r.writeAllowed ? copy.mayWrite : copy.readOnly}
          </span>
        )}
        {r.fromName && r.resultTo === "lead" && (
          <span className="lead-request-access">{copy.toLead}</span>
        )}
        {r.selfInitiated && (
          <span className="lead-request-access">{copy.selfInitiated}</span>
        )}
        {r.routine !== undefined && (
          <span className="lead-request-access">{copy.routine(r.routine)}</span>
        )}
        {r.memberRoutine !== undefined && (
          <span className="lead-request-access">{copy.routine(r.memberRoutine)}</span>
        )}
        <small>{requestState(r)}</small>
      </div>
      <p className="assistant-approval-task">
        {r.text}
        {r.truncated && !r.answer && (
          <>
            {"… "}
            <button type="button" className="link-button" onClick={load}>
              {copy.showAll}
            </button>
          </>
        )}
      </p>
      {r.ownerRequestQuote && (
        <p className="assistant-note">{copy.because(r.ownerRequestQuote)}</p>
      )}
      {(r.hasAnswer || r.answer || r.answerCut) && (
        <details
          className="assistant-team-report"
          onToggle={(event) => event.currentTarget.open && load()}
        >
          <summary>
            {r.type === "task"
              ? copy.result
              : r.type === "report"
                ? copy.report
                : copy.answer}
          </summary>
          {r.answer && <p>{r.answer}</p>}
          {r.answerCut && (
            <p className="assistant-note">
              {copy.answerShortened}
              {memberChat && navigate && (
                <>
                  {" "}
                  <RouteLink route={memberChat} navigate={navigate}>
                    {copy.openMemberChat}
                  </RouteLink>
                </>
              )}
            </p>
          )}
        </details>
      )}
      {r.delivery === "failed" && <p className="assistant-note">{copy.followUpFailed}</p>}
      {open.has(r.phase) && (
        <div className="assistant-card-actions">
          <button
            type="button"
            disabled={busy}
            className="button secondary"
            onClick={() => act(() => assistantApi.cancelLeadRequest(r.id))}
          >
            {commonCopy.cancel}
          </button>
        </div>
      )}
    </article>
  );
}
