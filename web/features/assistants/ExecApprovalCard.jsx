import React, { useState } from "react";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { assistantShellCopy } from "../../lib/i18n/messages/assistant-shell.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import useAssistants from "./useAssistants.js";
import "./exec-approval-card.css";

const longCommand = 240;
const longLines = 4;

/** Why "Always allow" only allows this command once, from the server's plan. */
function onceReason(plan) {
  const copy = assistantShellCopy.exec;
  if (plan.program && copy.onceReasons[plan.reason])
    return copy.onceReasons[plan.reason](plan.program);
  return copy.onceCommandReasons[plan.reason] || copy.onceCommandReasons.unresolved;
}

/**
 * A shell command waiting for the owner. `decide(id, decision)` sends
 * allow-once, allow-always or deny. When OpenClaw withholds allow-always,
 * AgentPier answers it from the frozen `allowAlwaysPlan`: program entries the
 * owner confirms after reading what they allow, or allow-once with the reason.
 */
export default function ExecApprovalCard({ action, decide }) {
  const copy = assistantShellCopy.exec;
  const { assistants } = useAssistants();
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const payload = action.payload || {};
  const command = String(payload.command || "");
  const long = command.length > longCommand || command.split("\n").length > longLines;
  const agent =
    assistants.find((a) => a.id === action.assistantId)?.name || payload.agentId || "";
  const plan = action.allowAlwaysByAgentPier ? action.allowAlwaysPlan : null;
  const paths = plan?.kind === "paths" ? plan.paths || [] : [];
  const once = plan && plan.kind !== "paths";
  const expires = action.expiresAt || payload.expiresAt;
  async function send(decision) {
    setBusy(true);
    try {
      await decide(action.id, decision);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  const noteId = `exec-${action.id}-always`;
  return (
    <article
      className="assistant-approval-card exec-approval-card"
      data-pending=""
      aria-label={copy.title}
    >
      <div className="assistant-approval-head">
        <strong>{copy.title}</strong>
        <small>{assistantWorkflowCopy.states.awaiting_approval}</small>
      </div>
      <pre className={`exec-approval-command${long && !expanded ? " clamped" : ""}`}>
        <code>{command}</code>
      </pre>
      {long && (
        <button
          type="button"
          className="exec-approval-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? copy.showLess : copy.showFull}
        </button>
      )}
      <dl className="exec-approval-facts">
        {payload.cwd && (
          <>
            <dt>{copy.folder}</dt>
            <dd>
              <code>{payload.cwd}</code>
            </dd>
          </>
        )}
        {agent && (
          <>
            <dt>{copy.agent}</dt>
            <dd>{agent}</dd>
          </>
        )}
      </dl>
      {expires && (
        <p className="assistant-note">{copy.expires(formatTimestamp(expires))}</p>
      )}
      {payload.warningText && (
        <p className="exec-approval-note">
          {copy.note}: {payload.warningText}
        </p>
      )}
      {once && (
        <p id={noteId} className="assistant-note">
          {copy.alwaysOnce(onceReason(plan))}
        </p>
      )}
      {confirming ? (
        <div
          className="exec-approval-confirm"
          role="alertdialog"
          aria-label={copy.allowAlways}
        >
          <p>{copy.alwaysPrograms(paths.join(", "))}</p>
          {plan.writable?.length > 0 && <p>{copy.writable(plan.writable.join(", "))}</p>}
          <div className="assistant-card-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => send("allow-always")}
            >
              {copy.confirmAlways}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {copy.back}
            </button>
          </div>
        </div>
      ) : (
        <div className="assistant-card-actions exec-approval-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => send("allow-once")}
          >
            {copy.allowOnce}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            aria-describedby={once ? noteId : undefined}
            onClick={() => (paths.length ? setConfirming(true) : send("allow-always"))}
          >
            {copy.allowAlways}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => send("deny")}
          >
            {copy.deny}
          </button>
        </div>
      )}
    </article>
  );
}
