import React, { useId, useRef, useState } from "react";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { assistantSshCopy as copy } from "../../lib/i18n/messages/assistant-ssh.js";
import useAssistants from "./useAssistants.js";
import SshCommandText from "./SshCommandText.jsx";
import { commandLines, hasHiddenCharacters } from "./ssh-command-text.js";
import { sshSeconds } from "./ssh-run-note.js";
import "./ssh-approval-card.css";

const collapseAfter = 40;
const shortFingerprint = (value = "") =>
  value.length > 24 ? `${value.slice(0, 20)}…` : value;

/**
 * An agent's SSH command: waiting for the owner (Allow once / Deny), running, or its
 * final state. `viewerId` is the agent whose chat shows the card: the lead sees who
 * asked, the member sees for whom.
 */
export default function SshApprovalCard({ action, decide, viewerId }) {
  const card = copy.card;
  const { assistants } = useAssistants();
  const name = (id) => assistants.find((a) => a.id === id)?.name || "";
  const p = action.payload || {};
  const command = String(p.command || "");
  const long = commandLines(command) > collapseAfter;
  const [expanded, setExpanded] = useState(!long);
  const [busy, setBusy] = useState(false);
  const [fullKey, setFullKey] = useState(false);
  const status = useRef(null);
  const id = useId();
  const waiting = action.state === "awaiting_approval";
  async function send(decision) {
    setBusy(true);
    try {
      await decide(action.id, decision);
    } finally {
      setBusy(false);
      // Focus stays on the card; the new state is announced (aria-live).
      status.current?.focus();
    }
  }
  const member =
    viewerId && action.assistantId !== viewerId ? name(action.assistantId) : "";
  const lead =
    action.leadAssistantId && action.leadAssistantId !== viewerId
      ? name(action.leadAssistantId)
      : "";
  const r = action.result || {};
  const state =
    action.state === "cancelled" && action.diagnostic === "HOST_REMOVED"
      ? card.removed
      : card.states[action.state] || card.states.unknown;
  return (
    <article
      className="assistant-approval-card ssh-approval-card"
      data-pending={waiting ? "" : undefined}
      aria-labelledby={`${id}-title`}
    >
      <div className="assistant-approval-head">
        <strong id={`${id}-title`}>{card.title}</strong>
        <small ref={status} tabIndex={-1} role="status" aria-live="polite">
          {action.state === "executing" && (
            <span className="ssh-spinner" aria-hidden="true" />
          )}
          {state}
        </small>
      </div>
      <dl className="exec-approval-facts ssh-approval-facts">
        <dt>{card.agent}</dt>
        <dd>
          {member ? card.requestedBy(member) : name(action.assistantId)}
          {lead && ` · ${card.forLead(lead)}`}
        </dd>
        <dt>{card.host}</dt>
        <dd>
          {p.hostName} <code>{copy.endpoint(p.username, p.host, p.port)}</code>
          {p.projectName && (
            <span className="ssh-project-badge">{copy.project(p.projectName)}</span>
          )}
        </dd>
        <dt>{card.hostKey}</dt>
        <dd>
          <button
            type="button"
            className="ssh-host-key"
            aria-expanded={fullKey}
            aria-label={card.showHostKey}
            onClick={() => setFullKey(!fullKey)}
          >
            <code>
              {fullKey ? p.hostFingerprint : shortFingerprint(p.hostFingerprint)}
            </code>
          </button>
        </dd>
      </dl>
      <p className="assistant-note">{card.timeout(p.timeoutSeconds)}</p>
      {hasHiddenCharacters(command) && (
        <p className="ssh-approval-warning">{card.hidden}</p>
      )}
      <pre
        className={`exec-approval-command ssh-approval-command${expanded ? "" : " clamped"}`}
        tabIndex={0}
      >
        <code>
          <SshCommandText command={command} />
        </code>
      </pre>
      {long && (
        <button
          type="button"
          className="exec-approval-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? card.showLess : card.showAll}
        </button>
      )}
      {action.state === "completed" && (
        <p className="ssh-approval-result">
          {r.interactive && r.exitCode == null && !r.signal
            ? card.interactive
            : card.exit(r.exitCode ?? r.signal)}
          {r.durationMs != null && ` · ${card.duration(sshSeconds(r.durationMs))}`}
          {r.timedOut && <span className="ssh-badge">{card.timedOut}</span>}
          {r.truncated && <span className="ssh-badge">{card.truncated}</span>}
        </p>
      )}
      {waiting && action.expiresAt && (
        <p className="assistant-note">
          {card.expires(formatTimestamp(action.expiresAt))}
        </p>
      )}
      {waiting && !expanded && (
        <p className="assistant-note" id={`${id}-expand`}>
          {card.expandFirst}
        </p>
      )}
      {waiting && (
        <div className="assistant-card-actions ssh-approval-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || !expanded}
            aria-describedby={expanded ? undefined : `${id}-expand`}
            onClick={() => send("approve")}
          >
            {card.allowOnce(p.hostName)}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => send("decline")}
          >
            {card.deny(p.hostName)}
          </button>
        </div>
      )}
    </article>
  );
}
