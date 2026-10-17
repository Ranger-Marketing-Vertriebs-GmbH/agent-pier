import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
import ExecApprovalCard from "./ExecApprovalCard.jsx";
import SshApprovalCard from "./SshApprovalCard.jsx";
import MemberGrantApprovalCard from "./MemberGrantApprovalCard.jsx";

const isExec = (a) => a.payload.action === "exec";
const isSsh = (a) => a.payload.action === "ssh";
const isGrant = (a) => a.payload.action === "member_grant";

// The agent's own pending actions as cards in the transcript (handoff 2c). The chat
// loads them once (useAssistantActions) and also counts them in the approval strip.
export default function AssistantActionApprovals({
  actions,
  error,
  decide,
  assistantId,
}) {
  const [busy, setBusy] = useState(false);
  async function choose(a, decision) {
    setBusy(true);
    try {
      await decide(a, decision);
    } finally {
      setBusy(false);
    }
  }
  if (!actions.length && !error) return null;
  // Shell and SSH commands have their own cards; they decide through
  // `decide(id, decision)`. An SSH card stays while its allowed command runs.
  const others = actions.filter((a) => !isExec(a) && !isSsh(a) && !isGrant(a));
  return (
    <section className="assistant-action-approvals" aria-label={copy.pendingApprovals}>
      <h3 className="sr-only">{copy.pendingApprovals}</h3>
      <ErrorMessage error={error} />
      {actions.filter(isExec).map((a) => (
        <ExecApprovalCard key={a.id} action={a} decide={(_, d) => decide(a, d)} />
      ))}
      {actions.filter(isSsh).map((a) => (
        <SshApprovalCard
          key={a.id}
          action={a}
          viewerId={assistantId}
          decide={(_, d) => decide(a, d)}
        />
      ))}
      {actions.filter(isGrant).map((a) => (
        <MemberGrantApprovalCard key={a.id} action={a} busy={busy} choose={choose} />
      ))}
      {others.map((a) => (
        <article className="assistant-approval-card" data-pending="" key={a.id}>
          <div className="assistant-approval-head">
            <strong>
              {a.payload.action === "coding_start" ? copy.coding : copy.memory}
            </strong>
            <small>{copy.states.awaiting_approval}</small>
          </div>
          {(a.projectName || a.pipelineName) && (
            <p>
              {a.projectName}
              {a.pipelineName ? ` · ${a.pipelineName}` : ""}
            </p>
          )}
          {a.payload.title && (
            <strong className="assistant-approval-title">{a.payload.title}</strong>
          )}
          <p className="assistant-approval-task">{a.payload.task || a.payload.content}</p>
          {a.payload.baseBranch && (
            <p>
              {copy.branch}: {a.payload.baseBranch}
            </p>
          )}
          <div className="assistant-card-actions">
            {["approve", "decline"].map((decision) => (
              <button
                key={decision}
                type="button"
                disabled={busy}
                className={`button ${decision === "approve" ? "primary" : "secondary"}`}
                onClick={() => choose(a, decision)}
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
