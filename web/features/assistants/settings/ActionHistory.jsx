import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import api from "../../../lib/api.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantSshCopy } from "../../../lib/i18n/messages/assistant-ssh.js";
import { assistantWorkflowCopy as copy } from "../../../lib/i18n/messages/assistant-workflows.js";
import ExecApprovalCard from "../ExecApprovalCard.jsx";
import SshApprovalCard from "../SshApprovalCard.jsx";
import SftpApprovalCard from "../SftpApprovalCard.jsx";
import { assistantSftpCopy } from "../../../lib/i18n/messages/assistant-sftp.js";
import { sftpHistoryText } from "../sftp-run-note.js";
import SshCommandText from "../SshCommandText.jsx";
import { sshHistoryText } from "../ssh-run-note.js";
import SubpageHeader from "./SubpageHeader.jsx";
import MemberGrantApprovalCard from "../MemberGrantApprovalCard.jsx";
import MemberGrantNote from "../MemberGrantNote.jsx";
import { grantNote } from "../member-grants.js";

const decide = (action, decision) =>
  api(`/assistant-actions/${encodeURIComponent(action.id)}/decision`, "POST", {
    revision: action.revision,
    decision,
  });

// A shell command takes the Gateway's decisions (allow-once, allow-always, deny):
// waiting, it is the chat's card; decided, it shows the command and its outcome.
function ExecCard({ action: a, act }) {
  if (a.state === "awaiting_approval")
    return <ExecApprovalCard action={a} decide={(_, d) => act(() => decide(a, d))} />;
  return (
    <article className="assistant-card assistant-reminder-row">
      <h3>{assistantShellCopy.exec.history}</h3>
      <pre className="exec-approval-command">
        <code>{a.payload.command}</code>
      </pre>
      {a.payload.cwd && (
        <p>
          {assistantShellCopy.exec.folder}: <code>{a.payload.cwd}</code>
        </p>
      )}
      <p>{copy.states[a.state]}</p>
    </article>
  );
}

// An SSH command: waiting or running, it is the chat's card; otherwise one line with
// the host, the outcome and the command (up to 8 KiB for trusted rows, only the first
// line for older ones) with recognisable secrets redacted.
function SshCard({ action: a, act, assistantId }) {
  if (["awaiting_approval", "executing"].includes(a.state))
    return (
      <SshApprovalCard
        action={a}
        viewerId={assistantId}
        decide={(_, d) => act(() => decide(a, d))}
      />
    );
  return (
    <article className="assistant-card assistant-reminder-row">
      <h3>{sshHistoryText(a)}</h3>
      {a.payload.trusted && (
        <p className="assistant-note">{assistantSshCopy.history.trusted}</p>
      )}
      {a.payload.commandRedacted && (
        <p className="assistant-note" data-command-redacted>
          {assistantSshCopy.note.redacted}
        </p>
      )}
      <pre className="exec-approval-command ssh-approval-command ssh-history-command">
        <code>
          <SshCommandText command={a.payload.command ?? a.payload.commandPreview ?? ""} />
        </code>
      </pre>
    </article>
  );
}

// An SFTP operation: waiting or running, it is the chat's card; otherwise one line
// with the operation, host, outcome, files, size and duration.
function SftpCard({ action: a, act, assistantId }) {
  if (["awaiting_approval", "executing"].includes(a.state))
    return (
      <SftpApprovalCard
        action={a}
        viewerId={assistantId}
        decide={(_, d) => act(() => decide(a, d))}
      />
    );
  return (
    <article className="assistant-card assistant-reminder-row" data-sftp-history>
      <h3>{sftpHistoryText(a)}</h3>
      {a.payload.trusted && (
        <p className="assistant-note">{assistantSftpCopy.history.trusted}</p>
      )}
    </article>
  );
}

function ActionCard({ action: a, assistantId, busy, act }) {
  if (a.payload.action === "ssh")
    return <SshCard action={a} act={act} assistantId={assistantId} />;
  if (a.payload.action === "sftp")
    return <SftpCard action={a} act={act} assistantId={assistantId} />;
  if (a.payload.action === "exec") return <ExecCard action={a} act={act} />;
  // A lead's edit of a member, or a member's reminder on its lead: its chat line.
  if (
    ["member_update", "member_reminder", "member_promote", "member_summarise"].includes(
      a.payload.action,
    )
  )
    return (
      <article className="assistant-card assistant-reminder-row">
        <MemberGrantNote
          note={{
            ...a.payload,
            event: a.payload.action.replace("_", "-"),
          }}
        />
      </article>
    );
  // A lead's grant to a team member: the owner's card while it waits, then its line.
  if (a.payload.action === "member_grant")
    return a.state === "awaiting_approval" ? (
      <MemberGrantApprovalCard
        action={a}
        busy={busy}
        choose={(action, decision) => act(() => decide(action, decision))}
      />
    ) : (
      <article className="assistant-card assistant-reminder-row">
        <MemberGrantNote note={grantNote(a)} />
      </article>
    );
  return (
    <article className="assistant-card assistant-reminder-row">
      <h3>{a.payload.action === "coding_start" ? copy.coding : copy.memory}</h3>
      {a.requestedBy && <p>{copy.requestedBy(a.memberName)}</p>}
      {a.requestedBy && a.state === "awaiting_approval" && (
        <p className="assistant-note">{copy.memberApprovalHint}</p>
      )}
      <p>
        {a.projectName}
        {a.pipelineName ? ` · ${a.pipelineName}` : ""}
      </p>
      <p>{copy.states[a.state]}</p>
      {a.diagnostic && copy.diagnostics[a.diagnostic] && (
        <p className="assistant-note">{copy.diagnostics[a.diagnostic]}</p>
      )}
      {a.payload.title && <strong>{a.payload.title}</strong>}
      <p className="assistant-memory-text">{a.payload.task || a.payload.content}</p>
      {a.payload.baseBranch && (
        <p>
          {copy.branch}: {a.payload.baseBranch}
        </p>
      )}
      {a.payload.expectedRevision && (
        <p>
          {copy.revision}: {a.payload.expectedRevision}
        </p>
      )}
      {a.run && (
        <>
          <p>
            {copy.runStatus}: {copy.runStates[a.run.status] || copy.states.unknown}
          </p>
          <a href={a.run.url} className="button secondary">
            {a.run.status === "awaiting-human" ? copy.humanGate : copy.openRun}
          </a>
          {a.run.nodes?.map((n) => (
            <p key={n.id}>
              {n.profileName} · {copy.nodeStates[n.status] || copy.states.running}
            </p>
          ))}
        </>
      )}
      <div className="assistant-actions">
        {a.state === "awaiting_approval" &&
          ["approve", "decline"].map((decision) => (
            <button
              key={decision}
              disabled={busy}
              className={`button ${decision === "approve" ? "primary" : "secondary"}`}
              onClick={() => act(() => decide(a, decision))}
            >
              {copy[decision]}
            </button>
          ))}
        {a.state === "running" && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              act(() =>
                api(
                  `/assistants/${encodeURIComponent(assistantId)}/actions/${encodeURIComponent(a.id)}/cancel`,
                  "POST",
                  {},
                ),
              )
            }
          >
            {copy.cancel}
          </button>
        )}
        {a.state === "unknown" && (
          <>
            <p className="assistant-note">{copy.unknownHint}</p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => act(() => decide(a, "review"))}
            >
              {copy.review}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** "Aktionen und Coding-Aufträge": every action, newest first, with its decisions. */
export default function ActionHistory({ history, assistantId, onBack }) {
  return (
    <section className="agent-subpage" aria-label={copy.actions}>
      <SubpageHeader title={copy.actions} tab="work" onBack={onBack} />
      <ErrorMessage error={history.error} />
      {history.loaded && !history.actions.length && (
        <p className="assistant-note">{copy.noActions}</p>
      )}
      {history.actions
        .slice()
        .reverse()
        .map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            assistantId={assistantId}
            busy={history.busy}
            act={history.act}
          />
        ))}
    </section>
  );
}
