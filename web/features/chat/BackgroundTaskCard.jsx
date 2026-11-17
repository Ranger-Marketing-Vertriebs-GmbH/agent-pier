import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { backgroundTasksCopy as copy } from "../../lib/i18n/messages/chat.js";
import { chatObservabilityCopy } from "../../lib/i18n/messages/chat-observability.js";
import { subagentStatus, subagentStatusLabel } from "./subagent-presentation.js";
import { stopTask } from "./task-actions.js";
import { usageSummary } from "./token-presentation.js";

/** The title a card and its detail view show. */
export const taskTitle = (entry) =>
  entry.kind === "shell"
    ? entry.description || entry.command || entry.id
    : entry.name || entry.id;

const stopMessage = (error) =>
  error.code === "TASK_STOP_REFUSED" && error.reason
    ? copy.stopRefused(error.message, error.reason)
    : error.message;

/**
 * The stop button of a running task: busy while the request runs, errors inline.
 * After a stop it stays busy until the chat frame changes the entry's status or
 * `canStop` (the busy state belongs to the entry state it was pressed in).
 */
function useStop(sessionId, entry) {
  const state = `${entry.status}:${Boolean(entry.canStop)}`;
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(state);
  const [error, setError] = useState("");
  if (seen !== state) {
    // Adjusting state during render: the entry changed, so the press is over.
    setSeen(state);
    setBusy(false);
  }
  const stop = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await stopTask(sessionId, entry.id);
    } catch (failure) {
      // TASK_STOP_NOT_RUNNING: the task ended by itself a moment earlier; the next
      // frame moves the card as well.
      setError(stopMessage(failure));
      setBusy(false);
    }
  };
  return { busy, error, stop };
}

// A shell's exit code once it ended by itself; a stopped one's (-1, a signal) says
// nothing the status does not.
const shownExitCode = (entry) =>
  ["completed", "failed"].includes(entry.status) && Number.isInteger(entry.exitCode)
    ? entry.exitCode
    : null;

/**
 * One subagent or shell in the background tasks sheet: its kind, title and state,
 * a stop button while the server allows it, and the way to its transcript or output.
 * A shell names the agent that started it (`agentName(id)`, the id when unknown) and
 * its exit code.
 */
export default function BackgroundTaskCard({
  entry,
  sessionId,
  timed = false,
  onOpen,
  agentName = () => null,
}) {
  const { busy, error, stop } = useStop(sessionId, entry);
  const shell = entry.kind === "shell";
  const usage = shell ? null : usageSummary(entry.usage);
  const exitCode = shell ? shownExitCode(entry) : null;
  const owner =
    shell && entry.ownerAgentId
      ? agentName(entry.ownerAgentId) || entry.ownerAgentId
      : null;
  const title = taskTitle(entry);
  const command = shell && entry.command && entry.command !== title;
  const detail = shell
    ? entry.hasOutput && { view: "output", label: copy.showOutput }
    : entry.hasTranscript && { view: "transcript", label: copy.showTranscript };
  return (
    <article className="subagent-entry" data-task-id={entry.id} data-kind={entry.kind}>
      <div className="task-card-head">
        <strong className={shell && !command ? "task-command" : undefined}>
          {title}
        </strong>
        {entry.canStop && (
          <button
            type="button"
            className="icon-button task-stop"
            aria-label={copy.stop}
            title={copy.stop}
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={stop}
          >
            <Icon name="stop" />
          </button>
        )}
      </div>
      {command && <code className="task-command">{entry.command}</code>}
      {!shell && <p>{entry.task || chatObservabilityCopy.noTask}</p>}
      <div className="subagent-meta">
        <span>{shell ? copy.kindShell : copy.kindAgent}</span>
        <small className={`subagent-status ${subagentStatus(entry)}`}>
          {subagentStatusLabel(entry.status)}
        </small>
        {exitCode !== null && (
          <small className="task-exit">{copy.exitCode(exitCode)}</small>
        )}
        {owner && <small className="task-owner">{copy.ownerAgent(owner)}</small>}
        {timed && entry.updatedAt && (
          <time dateTime={entry.updatedAt}>{formatTimestamp(entry.updatedAt)}</time>
        )}
        {usage && <small className="subagent-usage">{usage}</small>}
      </div>
      {detail && (
        <div className="task-card-actions">
          <button
            type="button"
            className="button secondary compact"
            onClick={(event) => onOpen(entry, detail.view, event.currentTarget)}
          >
            {detail.label}
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
    </article>
  );
}
