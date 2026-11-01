import { isDeepStrictEqual } from "node:util";

/**
 * AgentPier's own model of a routine: one scheduled agent run, whatever runtime
 * schedules it. Reminders, routines, check-ins, hook runs, a lead's routines and the
 * jobs an agent made itself are all routines to the routines sub-port
 * (runtimes/agent-runtime.js); each adapter translates them into its scheduler's own
 * jobs (OpenClaw: runtimes/openclaw/openclaw-routine-jobs.js) and back. Fields left
 * out of an added routine stay the runtime's default; an update's `patch` names only
 * the fields that change.
 *
 * @typedef {object} Routine
 * @property {string} [id] The runtime's id of the routine (read): AgentPier stores it
 *   as an opaque string (a binding's `nativeId`, a hook event's `jobId`).
 * @property {string} name The name the owner sees.
 * @property {string|null} marker AgentPier's identity of the routine: reminderMarker
 *   (reminders, routines, check-ins) or hookMarker (hook runs); null for a routine
 *   the agent made itself.
 * @property {string} agentId The runtime agent that runs it (`runtimeAgentId`).
 * @property {boolean} [enabled] Whether it runs when due; absent when the runtime did
 *   not say. A paused routine still runs when forced.
 * @property {boolean} [keepAfterRun] A one-shot routine stays after its run.
 * @property {RoutineSchedule|null} schedule When it runs; null for a schedule
 *   AgentPier does not know.
 * @property {RoutinePrompt|null} prompt The agent turn it runs; null when it runs no
 *   agent turn (a note an agent scheduled for itself).
 * @property {RoutineTarget} target Which session the turn runs in.
 * @property {RoutineDelivery|null} delivery Where the result goes.
 * @property {boolean} [wakeNow] A due run starts at once, not with the next heartbeat.
 * @property {boolean} [alertOnFailure] Whether the runtime's own failure alert is
 *   on; AgentPier only switches it off.
 * @property {number|null} [revision] Changes with every change (read).
 * @property {RoutineRunState} [runState] How its runs went (read).
 *
 * @typedef {{ kind: "cron", expression: string, timezone?: string }
 *   | { kind: "at", at: string }
 *   | { kind: "every", everyMs: number, anchorMs?: number }} RoutineSchedule
 *   A five-field cron expression in an IANA time zone, one time (ISO timestamp with
 *   an offset) or an interval.
 *
 * @typedef {object} RoutinePrompt
 * @property {string} text The message the agent receives.
 * @property {number} [timeoutSeconds] How long a run may take.
 * @property {boolean} [fullContext] The run sees the agent's instructions, notes and
 *   the target session's recent tail; false runs with a light context.
 * @property {string[]} [tools] The tools the run may use (capped by the agent's).
 * @property {string} [model] A model for this routine's runs instead of the agent's.
 *
 * @typedef {{ kind: "chat", sessionKey: string } | { kind: "own" } | { kind: "main" }
 *   | { kind: "other" }} RoutineTarget
 *   A specific chat (its runtime session key, the result committed there once no
 *   turn runs in it), a fresh session of its own per run, the agent's main session, or
 *   a target only the runtime knows.
 *
 * @typedef {{ kind: "chat", url?: string } | { kind: "webhook", url: string }
 *   | { kind: "none" } | { kind: "other", url?: string }} RoutineDelivery
 *   "chat": the result is committed into the target chat and handed to AgentPier's
 *   completion webhook `url`; "webhook": only handed to `url`; "none": silent.
 *
 * @typedef {object} RoutineRunState
 * @property {number} [nextRunAtMs] When it runs next.
 * @property {number} [runningAtMs] Since when a run is under way.
 * @property {number} [lastRunAtMs] When the last run started.
 * @property {string} [lastStatus] How the last run ended ("ok", "error", "skipped").
 * @property {string} [lastDeliveryStatus] Whether its result was delivered.
 * @property {string} [lastError] The runtime's error text of the last failed run.
 * @property {string} [lastErrorReason] The runtime's reason code for it.
 * @property {number} [failuresInRow] How many runs failed in a row.
 *
 * @typedef {object} RoutineRun One run record (routines.runs).
 * @property {number} runAtMs When it started.
 * @property {string} status "ok", "error" or "skipped".
 * @property {string} [completionStatus] How the completion went.
 * @property {string} [deliveryStatus] Whether its result was delivered.
 * @property {number} [durationMs] How long it took.
 * @property {string} [error] The runtime's error text.
 * @property {string} [errorReason] The runtime's reason code.
 * @property {string} [sessionKey] The run's session (routines.runOf tells which).
 *
 * @typedef {object} RoutineRunSession What routines.runOf(sessionKey) answers.
 * @property {string} agentId The runtime agent of the run.
 * @property {string} routineId The routine's id.
 * @property {string|null} runId The run's id; null for the routine's own session.
 * @property {string} routineSession The routine's own session key, which serves the
 *   transcript of its latest run.
 */

// AgentPier's markers. The strings are stored with each runtime job, so they never
// change: existing jobs keep being found.
const ownMarker = "agentpier-";
const hookPrefix = "agentpier-hook:";

/** The marker of a reminder, routine or check-in binding. */
export const reminderMarker = (bindingId) => `agentpier-reminder:${bindingId}`;

/** The marker of a hook event's run. */
export const hookMarker = (eventId) => `${hookPrefix}${eventId}`;

/** The hook event a routine runs, or null for any other routine. */
export const hookEventOf = (routine) =>
  routine?.marker?.startsWith(hookPrefix)
    ? routine.marker.slice(hookPrefix.length)
    : null;

/** Whether AgentPier set the routine up (any marker of its own). */
export const agentPierRoutine = (routine) =>
  String(routine?.marker || "").startsWith(ownMarker);

/**
 * A routine schedule from AgentPier's stored and offered schedule (reminder-input.js,
 * heartbeat-schedule.js): `{ kind: "cron", expr, tz }` or `{ kind: "at", at }`.
 */
export function routineSchedule(schedule) {
  if (schedule?.kind === "at") return { kind: "at", at: schedule.at };
  return {
    kind: "cron",
    expression: schedule.expr,
    ...(schedule.tz !== undefined && { timezone: schedule.tz }),
  };
}

/** AgentPier's offered schedule of a routine schedule, or null for another kind. */
export function offeredSchedule(schedule) {
  if (schedule?.kind === "at") return { kind: "at", at: schedule.at };
  if (schedule?.kind === "cron")
    return { kind: "cron", expr: schedule.expression, tz: schedule.timezone };
  return null;
}

/** The target of a run in a chat: its runtime session key. */
export const chatTarget = (sessionKey) => ({ kind: "chat", sessionKey });

/**
 * Whether a routine already runs as `want` ({ target, prompt, delivery }) says: the
 * same session, every prompt field `want` names, and the same delivery and address.
 */
export function sameRun(routine, want) {
  return (
    routine.target?.kind === want.target.kind &&
    (want.target.kind !== "chat" ||
      routine.target.sessionKey === want.target.sessionKey) &&
    Object.entries(want.prompt).every(([key, value]) =>
      isDeepStrictEqual(routine.prompt?.[key], value),
    ) &&
    // A prompt is only an agent turn: a routine without one never matches.
    !!routine.prompt &&
    routine.delivery?.kind === want.delivery.kind &&
    routine.delivery?.url === want.delivery.url
  );
}
