import { assistantSshCopy as copy } from "../../lib/i18n/messages/assistant-ssh.js";

// Transcript events an agent chat shows as an ActivityRow (TranscriptItem.jsx).
export const activityEvents = new Set(["ssh-run"]);
// Outcomes of a run that still counts as done; a running one has none yet.
const settled = new Set(["done", "truncated"]);

/** Whether an activity note is still running, ended well or failed. */
export function activityState(message) {
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
 * A group's head: "SSH activity", the number of calls with the one host they share
 * (or the number of hosts), and a chip that keeps failures visible while it is shut.
 */
export function activityGroupView(messages) {
  const t = copy.group;
  const hosts = new Set(messages.map((m) => m.hostName));
  const states = messages.map(activityState);
  const failed = states.filter((s) => s === "failed").length;
  const running = states.includes("running");
  const status = [running && t.running, failed && t.failed(failed)].filter(Boolean);
  return {
    label: t.label,
    detail: `${t.calls(messages.length)} · ${
      hosts.size === 1 ? [...hosts][0] : t.hosts(hosts.size)
    }`,
    status: status.length ? status.join(" · ") : t.done,
    tone: failed ? "error" : running ? "running" : "ok",
    failed,
    running,
  };
}
