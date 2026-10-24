import React, { useId, useRef, useState } from "react";
import { formatTimestamp, locale } from "../../lib/i18n/index.js";
import { assistantSshCopy } from "../../lib/i18n/messages/assistant-ssh.js";
import { assistantSftpCopy as copy } from "../../lib/i18n/messages/assistant-sftp.js";
import { formatBytes } from "../../lib/format-bytes.js";
import useAssistants from "./useAssistants.js";
import SshCommandText from "./SshCommandText.jsx";
import { hasHiddenCharacters } from "./ssh-command-text.js";
import { sftpOperationText, sftpProgressText } from "./sftp-run-note.js";
import "./ssh-approval-card.css";

const lists = ["create", "update", "delete", "deleteDirs"];
const shortFingerprint = (value = "") =>
  value.length > 24 ? `${value.slice(0, 20)}…` : value;
const cut = (s, key) => (key === "deleteDirs" ? s.moreDeleteDirs : s.more?.[key]) || 0;
const count = (s, key) => (s[key]?.length ?? 0) + cut(s, key);
// The local place and path in the catalog's order (card.local), the path as code.
const slot = "\u0000";
function localPlace(local) {
  const [before, after = ""] = copy.card
    .local(local.projectName || copy.card.workspace, slot)
    .split(slot);
  return (
    <>
      {before}
      <code>
        <SshCommandText command={local.path ?? "."} />
      </code>
      {after}
    </>
  );
}

/**
 * An agent's SFTP operation: waiting for the owner (Allow once, Always allow for
 * this host, Deny), running with its progress, or its final state. It shows the plan
 * made before the card: operation, `user@host:port` with the pinned host key, both
 * paths, the counts new/changed/deleted, the size, the overwrites and the path lists
 * behind a disclosure. "Always allow" only appears when the card offers it
 * (`payload.allowAlways`): never for deletes or a temporary member's lead grant.
 */
export default function SftpApprovalCard({ action, decide, viewerId }) {
  const card = copy.card;
  const { assistants } = useAssistants();
  const name = (id) => assistants.find((a) => a.id === id)?.name || "";
  const p = action.payload || {};
  const s = p.summary || {};
  const [busy, setBusy] = useState(false);
  const [fullKey, setFullKey] = useState(false);
  const [paths, setPaths] = useState(false);
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
  const progress =
    action.state === "executing" ? sftpProgressText(action.progress) : null;
  const state =
    action.state === "cancelled" && action.diagnostic === "HOST_REMOVED"
      ? card.removed
      : progress || card.states[action.state] || card.states.unknown;
  const planned = lists.some((key) => Array.isArray(s[key]));
  const deletes = count(s, "delete") + count(s, "deleteDirs");
  const named = [
    p.remotePath,
    p.toPath,
    p.local?.path,
    ...lists.flatMap((key) => s[key] || []),
  ].filter((value) => typeof value === "string");
  const fact = (term, value) =>
    value != null && (
      <>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </>
    );
  return (
    <article
      className="assistant-approval-card ssh-approval-card sftp-approval-card"
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
        {fact(
          card.agent,
          <>
            {member ? card.requestedBy(member) : name(action.assistantId)}
            {lead && ` · ${card.forLead(lead)}`}
          </>,
        )}
        {fact(card.operation, sftpOperationText(p.operation, p.direction))}
        {fact(
          card.host,
          <>
            {p.hostName}{" "}
            <code>{assistantSshCopy.endpoint(p.username, p.host, p.port)}</code>
            {p.projectName && (
              <span className="ssh-project-badge">
                {assistantSshCopy.project(p.projectName)}
              </span>
            )}
          </>,
        )}
        {fact(
          card.hostKey,
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
          </button>,
        )}
        {fact(
          card.remotePath,
          <code>
            <SshCommandText command={p.remotePath ?? ""} />
          </code>,
        )}
        {p.toPath &&
          fact(
            card.toPath,
            <code>
              <SshCommandText command={p.toPath} />
            </code>,
          )}
        {p.local && fact(card.localPath, localPlace(p.local))}
        {planned &&
          fact(card.counts, copy.counts(count(s, "create"), count(s, "update"), deletes))}
        {planned && s.bytes != null && fact(card.size, formatBytes(s.bytes, locale))}
        {planned &&
          p.operation !== "delete" &&
          fact(card.overwrites, String(s.overwrites || 0))}
      </dl>
      {named.some(hasHiddenCharacters) && (
        <p className="ssh-approval-warning">{card.hidden}</p>
      )}
      {deletes > 0 && (
        <p className="ssh-approval-warning" data-deletes={deletes}>
          {card.deletes(deletes)}
        </p>
      )}
      {p.deleteExtra && <p className="assistant-note">{card.deleteExtra}</p>}
      {planned && named.length > 0 && (
        <button
          type="button"
          className="exec-approval-toggle"
          aria-expanded={paths}
          aria-controls={`${id}-paths`}
          onClick={() => setPaths(!paths)}
        >
          {paths ? card.hidePaths : card.showPaths}
        </button>
      )}
      {planned && (
        <div id={`${id}-paths`} hidden={!paths}>
          {lists
            .filter((key) => count(s, key) > 0)
            .map((key) => (
              <section
                key={key}
                data-list={key}
                aria-label={card.lists[key]}
                data-delete={key.startsWith("delete") ? "" : undefined}
              >
                <p
                  className={
                    key.startsWith("delete") ? "ssh-approval-warning" : "assistant-note"
                  }
                >
                  {card.lists[key]}
                </p>
                {s[key]?.length > 0 && (
                  <pre className="exec-approval-command ssh-approval-command ssh-history-command">
                    <code>
                      <SshCommandText command={s[key].join("\n")} />
                    </code>
                  </pre>
                )}
                {cut(s, key) > 0 && (
                  <p className="assistant-note">{card.more(cut(s, key))}</p>
                )}
              </section>
            ))}
        </div>
      )}
      {waiting && action.expiresAt && (
        <p className="assistant-note">
          {card.expires(formatTimestamp(action.expiresAt))}
        </p>
      )}
      {waiting && (
        <div className="assistant-card-actions ssh-approval-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => send("approve")}
          >
            {card.allowOnce}
          </button>
          {p.allowAlways === true && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => send("allow-always")}
            >
              {card.allowAlways}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => send("decline")}
          >
            {card.deny}
          </button>
        </div>
      )}
    </article>
  );
}
