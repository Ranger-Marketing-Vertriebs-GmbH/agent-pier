import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
import { names as toolNames } from "../../lib/providers.js";
import ExecApprovalCard from "./ExecApprovalCard.jsx";
import SshApprovalCard from "./SshApprovalCard.jsx";
import SftpApprovalCard from "./SftpApprovalCard.jsx";
import MemberGrantApprovalCard from "./MemberGrantApprovalCard.jsx";
import HookProposalCard, { HookCreatedNote } from "./HookProposalCard.jsx";
import SshAccessProposalCard, { SshAccessCreatedNote } from "./SshAccessProposalCard.jsx";
import SessionRequestEscalationCard from "./SessionRequestEscalationCard.jsx";

const isExec = (a) => a.payload.action === "exec";
const isSsh = (a) => a.payload.action === "ssh";
const isSftp = (a) => a.payload.action === "sftp";
const isGrant = (a) => a.payload.action === "member_grant";
const isHook = (a) => a.payload.action === "hook_proposal";
const isSshAccess = (a) => a.payload.action === "ssh_access";
const isEscalation = (a) => a.payload.action === "session_request";
const heading = (a) =>
  ({ coding_start: copy.coding, session_start: copy.codingSession })[a.payload.action] ||
  copy.memory;
// An agent's coding session start names its CLI where a coding task names its pipeline.
const detail = (a) =>
  a.payload.action === "session_start"
    ? toolNames[a.payload.options?.tool] || a.payload.options?.tool
    : a.pipelineName;
const branchOf = (a) => a.payload.baseBranch || a.payload.options?.baseBranch;

// The agent's own pending actions as cards in the transcript (handoff 2c). The chat
// loads them once (useAssistantActions) and also counts them in the approval strip.
// The viewer is `assistantId`, or the chat's `assistant`; `go` navigates (to an
// approved hook's settings).
export default function AssistantActionApprovals({
  actions,
  error,
  decide,
  assistant,
  assistantId = assistant?.id,
  go,
}) {
  const [busy, setBusy] = useState(false);
  // Hooks the owner approved here: they leave the list, their secret waits in settings.
  const [created, setCreated] = useState([]);
  // SSH accesses he confirmed here, with the public key to install.
  const [accesses, setAccesses] = useState([]);
  async function choose(a, decision) {
    setBusy(true);
    try {
      await decide(a, decision);
    } finally {
      setBusy(false);
    }
  }
  if (!actions.length && !error && !created.length && !accesses.length) return null;
  // Shell and SSH commands and SFTP operations have their own cards; they decide
  // through `decide(id, decision)`. An SSH or SFTP card stays while its allowed
  // command or job runs.
  const others = actions.filter(
    (a) =>
      !isExec(a) &&
      !isSsh(a) &&
      !isSftp(a) &&
      !isGrant(a) &&
      !isHook(a) &&
      !isSshAccess(a) &&
      !isEscalation(a),
  );
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
      {actions.filter(isSftp).map((a) => (
        <SftpApprovalCard
          key={a.id}
          action={a}
          viewerId={assistantId}
          decide={(_, d) => decide(a, d)}
        />
      ))}
      {actions.filter(isGrant).map((a) => (
        <MemberGrantApprovalCard key={a.id} action={a} busy={busy} choose={choose} />
      ))}
      {actions.filter(isHook).map((a) => (
        <HookProposalCard
          key={a.id}
          action={a}
          onDecide={async (decision, rights) => {
            const decided = await decide(a, decision, rights ? { rights } : {});
            if (decided?.state === "completed" && decided.result?.hookId)
              setCreated((list) => [...list, decided]);
            return decided;
          }}
        />
      ))}
      {created.map((a) => (
        <HookCreatedNote key={a.id} action={a} navigate={go} />
      ))}
      {actions.filter(isSshAccess).map((a) => (
        <SshAccessProposalCard
          key={a.id}
          action={a}
          onDecide={async (decision, extra) => {
            const decided = await decide(a, decision, extra);
            if (decided?.state === "completed" && decided.result?.publicKey)
              setAccesses((list) => [...list, decided]);
            return decided;
          }}
        />
      ))}
      {accesses.map((a) => (
        <SshAccessCreatedNote key={a.id} action={a} />
      ))}
      {actions.filter(isEscalation).map((a) => (
        <SessionRequestEscalationCard
          key={a.id}
          action={a}
          agentName={assistant?.name}
          onNavigate={go}
        />
      ))}
      {others.map((a) => (
        <article className="assistant-approval-card" data-pending="" key={a.id}>
          <div className="assistant-approval-head">
            <strong>{heading(a)}</strong>
            <small>{copy.states.awaiting_approval}</small>
          </div>
          {(a.projectName || detail(a)) && (
            <p>
              {a.projectName}
              {detail(a) ? ` · ${detail(a)}` : ""}
            </p>
          )}
          {a.payload.title && (
            <strong className="assistant-approval-title">{a.payload.title}</strong>
          )}
          {(a.payload.task || a.payload.content) && (
            <p className="assistant-approval-task">
              {a.payload.task || a.payload.content}
            </p>
          )}
          {branchOf(a) && (
            <p>
              {copy.branch}: {branchOf(a)}
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
