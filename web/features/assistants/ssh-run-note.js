import { assistantSshCopy as copy } from "../../lib/i18n/messages/assistant-ssh.js";
import { visibleCommand } from "./ssh-command-text.js";

/** What an SSH run ended with, named like the server's notes (actionNotes). */
export function sshOutcome(result = {}, diagnostic) {
  if (result.reason === "revoked" || diagnostic === "SSH_REVOKED") return "revoked";
  if (result.timedOut) return "timedOut";
  if (result.truncated) return "truncated";
  return result.exitCode === 0 ? "done" : "exit";
}
export const sshSeconds = (ms) => String(Math.round(ms / 100) / 10);
export function sshOutcomeText(outcome, exitCode) {
  const label = copy.note.outcomes[outcome] ?? copy.note.outcomes.exit;
  return typeof label === "function" ? label(exitCode ?? "?") : label;
}
/** "SSH on opnsense: uptime · done"; hidden characters appear as their codes. */
export const sshRunNoteText = (note) =>
  `${copy.note.lead(note.hostName)} ${visibleCommand(note.commandPreview)} · ${sshOutcomeText(note.outcome, note.exitCode)}`;
/** One Work tab history line: host, outcome (or decision) and duration. */
export function sshHistoryText(action) {
  const r = action.result || {};
  const ran = ["completed", "failed"].includes(action.state) && "exitCode" in r;
  const parts = [
    copy.history.title(action.payload.hostName),
    ran
      ? sshOutcomeText(sshOutcome(r, action.diagnostic), r.exitCode ?? r.signal)
      : copy.card.states[action.state] || copy.card.states.unknown,
  ];
  if (ran && r.durationMs != null)
    parts.push(copy.card.duration(sshSeconds(r.durationMs)));
  return parts.join(" · ");
}
