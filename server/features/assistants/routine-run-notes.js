import { actionNotes } from "./assistant-action-notifications.js";

// What an unattended run did stays with that run in the chat's event area
// (agent-event-area.js), never in the transcript: a routine's or a hook's SSH runs
// and SFTP jobs, and a routine's memory note. Neither ever asks for an approval
// card (agent-ssh-origin.js permits, agent-sftp-policy.js), so nothing actionable
// leaves the transcript; a coding request a run makes keeps its approval card there.

/** An SSH run or SFTP job a routine or a hook started. */
export const unattendedRemote = (a) =>
  ["ssh", "sftp"].includes(a?.payload?.action) &&
  ["routine", "hook"].includes(a.origin?.kind);

// A routine flush's memory note is keyed by its run session (memory-write-policy.js).
const cronNote = /^memory-note:agent:[^:]+:cron:([^:]+)(?::run:[^:]+)?:/i;
/** A memory note a routine's run wrote. */
export const routineMemoryNote = (note) => cronNote.test(note?.id || "");

const jobOf = (result) => String(result.id).split(":")[0].toLowerCase();

// The routine result whose run covers `at` (from its start to its record), the
// latest such run when two overlap; `fits` narrows the candidates.
function runAt(results, at, fits) {
  return results.findLast((r) => fits(r) && r.runAtMs <= at && at <= r.at) || null;
}

/**
 * The run notes of a chat's routine results by result id, oldest first: the SSH
 * and SFTP notes of its routine actions (by the action's routine, or by time for
 * rows recorded before actions named it) and its routine memory notes. A note whose
 * run left no result (a silent run) has no row; the Work tab still lists the action.
 */
export function routineRunNotes({ results, actions, memoryNotes, conversationId }) {
  const runs = results
    .filter((r) => !r.kind && Number.isFinite(r.runAtMs))
    .sort((x, y) => x.runAtMs - y.runAtMs);
  const byRun = new Map();
  const add = (run, note) => {
    if (run) byRun.set(run.id, [...(byRun.get(run.id) || []), note]);
  };
  if (!runs.length) return byRun;
  for (const action of actions) {
    if (action.conversationId !== conversationId || action.origin?.kind !== "routine")
      continue;
    if (!unattendedRemote(action)) continue;
    const bindingId = action.origin.bindingId;
    for (const note of actionNotes([action], conversationId))
      add(
        runAt(runs, note.timestamp, (r) => !bindingId || r.bindingId === bindingId),
        note,
      );
  }
  for (const note of memoryNotes) {
    const job = cronNote.exec(note.id || "")?.[1]?.toLowerCase();
    if (job)
      add(
        runAt(runs, note.timestamp, (r) => jobOf(r) === job),
        note,
      );
  }
  for (const notes of byRun.values()) notes.sort((x, y) => x.timestamp - y.timestamp);
  return byRun;
}
