import { assistantSshCopy as copy } from "../../lib/i18n/messages/assistant-ssh.js";
import { assistantSftpCopy } from "../../lib/i18n/messages/assistant-sftp.js";

// Transcript events an agent chat shows as an ActivityRow (TranscriptItem.jsx).
export const activityEvents = new Set(["ssh-run", "sftp-run"]);
// Outcomes of a run that still counts as done; a running one has none yet.
const settled = new Set(["done", "truncated"]);

// An SFTP job's row state (agent-sftp-notes.js) as an activity state; a stopped job
// is neither done nor failed, like its row's neutral "Stopped".
const sftpStates = { executing: "running", completed: "ok", cancelled: "stopped" };

/** Whether an activity note is still running, ended well, was stopped or failed. */
export function activityState(message) {
  // An SFTP job has a row state instead of an outcome.
  if (message.event === "sftp-run") return sftpStates[message.state] ?? "failed";
  if (message.outcome === "running") return "running";
  return settled.has(message.outcome) ? "ok" : "failed";
}

/**
 * Folds two or more activity rows that follow one another in an agent chat's
 * transcript items (`{ message }` or `{ note }`) into one `{ key, activity }` item;
 * any other message or note ends the run, and a single row stays as it is. The key is
 * the first row's, so a group keeps its place while new calls join it.
 */
export function groupActivity(items) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 1)
      out.push({
        key: `activity:${run[0].message.id}`,
        activity: run.map((i) => i.message),
      });
    else out.push(...run);
    run = [];
  };
  for (const item of items) {
    if (!item.note && activityEvents.has(item.message?.event)) run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/**
 * A group's ActivityGroup props: "SSH activity" ("SFTP activity" when every call is
 * an SFTP job), the one host its calls share (or the number of hosts), and how many
 * calls failed, were stopped or still run.
 */
export function activityGroupView(messages) {
  const hosts = new Set(messages.map((m) => m.hostName));
  const states = messages.map(activityState);
  const failed = states.filter((s) => s === "failed").length;
  const stopped = states.filter((s) => s === "stopped").length;
  const running = states.includes("running");
  return {
    label: messages.every((m) => m.event === "sftp-run")
      ? assistantSftpCopy.group.label
      : copy.group.label,
    count: messages.length,
    summary: hosts.size === 1 ? [...hosts][0] : copy.group.hosts(hosts.size),
    failed,
    stopped,
    running,
    done: !failed && !stopped && !running,
  };
}
