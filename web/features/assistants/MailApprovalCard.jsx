import React, { useId, useRef, useState } from "react";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { assistantMailCopy } from "../../lib/i18n/messages/assistant-mail.js";
import useAssistants from "./useAssistants.js";
import SshCommandText from "./SshCommandText.jsx";
import { bodyLines, mailHasHidden, splitRecipient } from "./mail-card-text.js";
import "./exec-approval-card.css";
import "./ssh-approval-card.css";

const collapseAfter = 40;
// A body Telegram could not show in full wraps over many lines without breaks.
const collapseChars = 3000;

// One address as code, then any display name: a name that looks like an address
// never stands where the address belongs.
function Address({ address, name }) {
  return (
    <span className="mail-approval-address">
      <code>
        <SshCommandText command={address} />
      </code>
      {name && (
        <>
          {" "}
          (<SshCommandText command={name} />)
        </>
      )}
    </span>
  );
}

/**
 * An agent's email waiting for the owner (Send / Don't send), sending, or its final
 * state. It shows every to, cc and bcc recipient by address, the sender, the subject
 * and the whole body; only these buttons, or the Telegram ones, send it.
 */
export default function MailApprovalCard({ action, decide }) {
  const card = assistantMailCopy.card;
  const { assistants } = useAssistants();
  const p = action.payload || {};
  const body = String(p.body ?? "");
  const long = bodyLines(body) > collapseAfter || Array.from(body).length > collapseChars;
  const [expanded, setExpanded] = useState(!long);
  const [busy, setBusy] = useState(false);
  const status = useRef(null);
  const id = useId();
  const waiting = action.state === "awaiting_approval";
  async function send(decision) {
    setBusy(true);
    try {
      await decide(action.id, decision);
    } finally {
      setBusy(false);
      status.current?.focus();
    }
  }
  const agent = assistants.find((a) => a.id === action.assistantId)?.name || "";
  const state = card.states[action.state] || card.states.unknown;
  const recipients = (key) =>
    (p[key] ?? []).map((entry, i) => (
      <React.Fragment key={i}>
        {i > 0 && <br />}
        <Address {...splitRecipient(entry)} />
      </React.Fragment>
    ));
  return (
    <article
      className="assistant-approval-card exec-approval-card mail-approval-card"
      data-pending={waiting ? "" : undefined}
      data-state={action.state}
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
        {agent && (
          <>
            <dt>{card.agent}</dt>
            <dd>{agent}</dd>
          </>
        )}
        <dt>{card.account}</dt>
        <dd>{p.accountName}</dd>
        <dt>{card.from}</dt>
        <dd>
          <Address address={p.from?.address ?? ""} name={p.from?.name ?? ""} />
        </dd>
        {["to", "cc", "bcc"]
          .filter((key) => p[key]?.length)
          .map((key) => (
            <React.Fragment key={key}>
              <dt>{card[key]}</dt>
              <dd data-field={key}>{recipients(key)}</dd>
            </React.Fragment>
          ))}
        <dt>{card.subject}</dt>
        <dd data-field="subject">
          {p.subject ? <SshCommandText command={p.subject} /> : card.noSubject}
        </dd>
      </dl>
      {mailHasHidden(p) && <p className="ssh-approval-warning">{card.hidden}</p>}
      <pre
        className={`exec-approval-command mail-approval-body${expanded ? "" : " clamped"}`}
        tabIndex={0}
        aria-label={card.body}
      >
        <SshCommandText command={body} />
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
      {waiting && <p className="assistant-note">{card.onlyButtons}</p>}
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
            {card.send}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => send("decline")}
          >
            {card.decline}
          </button>
        </div>
      )}
    </article>
  );
}
