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
const tones = {
  done: "ok",
  exit: "error",
  timedOut: "error",
  revoked: "error",
  truncated: "neutral",
};
/**
 * An SSH run note (server actionNotes) as its activity row: label, the one-line
 * preview, the full command (or the preview where only that was recorded, `partial`),
 * the status chip and the facts of its body. `copyText` shows hidden characters as
 * their codes, so a copy holds what the owner sees.
 */
export function sshRunView(note) {
  const outcome = note.outcome in tones ? note.outcome : "exit";
  const status = copy.note.status[outcome];
  const command = note.command ?? note.commandPreview ?? "";
  return {
    label: copy.note.label(note.hostName),
    preview: note.commandPreview ?? command,
    command,
    copyText: visibleCommand(command),
    partial: note.command == null ? "preview" : note.commandCut ? "cut" : null,
    redacted: note.commandRedacted === true,
    tone: tones[outcome],
    status: typeof status === "function" ? status(note.exitCode ?? "?") : status,
    exitCode: note.exitCode ?? (outcome === "done" ? 0 : null),
    duration:
      note.durationMs != null ? copy.note.seconds(sshSeconds(note.durationMs)) : null,
    result: copy.note.results[outcome] ?? null,
  };
}
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
