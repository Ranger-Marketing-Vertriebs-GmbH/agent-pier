import React from "react";
import { assistantWorkflowCopy as workflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { memberGrantCopy as copy } from "../../lib/i18n/messages/assistant-member-grants.js";
import { grantLabels } from "./member-grants.js";

// A lead's later shell or SSH grant for a team member, waiting for the owner.
export default function MemberGrantApprovalCard({ action, busy, choose }) {
  const p = action.payload;
  return (
    <article
      className="assistant-approval-card"
      data-pending=""
      data-member-grant-approval=""
    >
      <div className="assistant-approval-head">
        <strong>{copy.approvalTitle}</strong>
        <small>{workflowCopy.states.awaiting_approval}</small>
      </div>
      <p>{copy.approvalText(p.memberName)}</p>
      <strong className="assistant-approval-title">
        ⚠ {grantLabels(p.grants).join(", ")}
      </strong>
      <p className="mcp-team-warning notice">{copy.approvalWarning}</p>
      <div className="assistant-card-actions">
        <button
          type="button"
          disabled={busy}
          className="button primary"
          onClick={() => choose(action, "approve")}
        >
          {copy.approve}
        </button>
        <button
          type="button"
          disabled={busy}
          className="button secondary"
          onClick={() => choose(action, "decline")}
        >
          {workflowCopy.decline}
        </button>
      </div>
    </article>
  );
}
