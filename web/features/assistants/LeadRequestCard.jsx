import React, { useState } from "react";
import { leadRequestCopy as copy } from "../../lib/i18n/messages/lead-requests.js";
import { assistantApi } from "./assistant-api.js";

const open = new Set(["queued", "dispatching", "running", "uncertain"]);
/** The state label; a finished question reads "Answered", a finished task "Done". */
export const requestState = (r) =>
  r.phase === "completed" && r.type === "question"
    ? copy.states.answered
    : copy.states[r.phase] || r.phase;

// What deciding hands over: the member's shell level, its MCP servers and, for a
// task, whether it may change files in its own workspace.
function MemberPower({ request: r }) {
  const power = r.member;
  if (!power) return null;
  const servers = power.mcpServers;
  const files =
    r.type !== "task"
      ? null
      : !power.files
        ? copy.readOnly(r.memberName)
        : r.phase === "awaiting_approval"
          ? copy.writesIfApproved(r.memberName)
          : r.writeAllowed
            ? copy.writes(r.memberName)
            : copy.readOnly(r.memberName);
  return (
    <ul className="lead-request-power">
      <li>{copy.shell(power.shell)}</li>
      <li>
        {servers === null
          ? copy.mcpUnavailable
          : servers.length
            ? copy.mcp(
                servers.map((s) => (s.stdio ? copy.stdio(s.name) : s.name)).join(", "),
              )
            : copy.noMcp}
      </li>
      {files && <li>{files}</li>}
    </ul>
  );
}

/**
 * A lead's question or task for one of its members. Waiting for the owner, it is
 * decided here (chat and Settings → Work → Teams); an open one can be cancelled.
 * Lists carry a summary; the whole text and answer load on demand.
 */
export default function LeadRequestCard({ request: summary, busy, act }) {
  const [detail, setDetail] = useState(null);
  const r =
    detail && detail.revision === summary.revision ? { ...summary, ...detail } : summary;
  const pending = r.phase === "awaiting_approval";
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
      data-pending={pending ? "" : undefined}
      aria-label={copy.title(r.type, r.memberName)}
    >
      <div className="assistant-approval-head">
        <strong>{copy.title(r.type, r.memberName)}</strong>
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
      <MemberPower request={r} />
      {(r.hasAnswer || r.answer) && (
        <details
          className="assistant-team-report"
          onToggle={(event) => event.currentTarget.open && load()}
        >
          <summary>{r.type === "task" ? copy.result : copy.answer}</summary>
          {r.answer && <p>{r.answer}</p>}
        </details>
      )}
      {r.delivery === "failed" && <p className="assistant-note">{copy.followUpFailed}</p>}
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
