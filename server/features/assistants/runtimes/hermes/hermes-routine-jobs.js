// AgentPier's routine model (../../routine-definition.js) in the cron jobs of Hermes's
// messaging gateway and back (Hermes v0.22.5 cron/jobs.py, the gateway-hosted REST
// routes hermes_cli/web_routers/cron.py). Hermes stores what it schedules and runs:
// the name, the prompt, the schedule (a five-field cron expression, an interval in
// minutes or one aware ISO time), a model override, `enabled`, delivery `local` (the
// result stays in Hermes; AgentPier delivers it, hermes-routines.js) and the run
// state. Everything else of the model rides along in the job's own `agentpier` field
// (Hermes keeps fields it does not know, update_job merges them): the marker, the
// agent, target, delivery, the prompt's run settings, the time zone and a revision.
// A cron routine in another time zone than the agent's process runs as a pinned job
// (hermes-cron-zone.js); its own expression rides in the meta.

import {
  knownZone,
  nextCronRun,
  pinnedExpression,
  processZone,
} from "./hermes-cron-zone.js";

/** The job field AgentPier keeps its part of a routine in. */
export const metaField = "agentpier";

// Only the fields given: a missing field stays missing.
const defined = (entries) =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined));

const invalid = (message) =>
  Object.assign(Error(message), {
    code: "INVALID_REQUEST",
    status: 400,
    answered: true,
  });

const msOf = (iso) => {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

// --- to Hermes --------------------------------------------------------------------

// Whether a cron routine's own zone differs from the zone Hermes runs it in.
const zoned = (timezone, zone) =>
  typeof timezone === "string" && !!timezone && timezone !== zone;

/**
 * The schedule string Hermes parses (cron/jobs.py parse_schedule): a cron expression,
 * `every <n>m` for an interval of whole minutes, or the ISO time of a one-shot.
 * Hermes runs cron expressions in the agent's process zone (`zone`, hermes_time),
 * not per job: a routine in another zone gets the pinned expression of its next
 * occurrence after `now` (hermes-cron-zone.js), pinned again after each run.
 */
export function hermesSchedule(
  schedule,
  { zone = processZone(), now = Date.now() } = {},
) {
  if (schedule?.kind === "cron") {
    if (
      typeof schedule.expression !== "string" ||
      schedule.expression.trim().split(/\s+/).length !== 5
    )
      throw invalid("A Hermes routine needs a five-field cron expression.");
    if (!zoned(schedule.timezone, zone)) return schedule.expression.trim();
    if (!knownZone(schedule.timezone)) throw invalid("Unknown routine time zone.");
    const next = nextCronRun(schedule.expression, schedule.timezone, now);
    if (next === null)
      throw invalid("A Hermes routine in its own time zone needs a standard expression.");
    return pinnedExpression(next, zone);
  }
  if (schedule?.kind === "at") {
    if (!Number.isFinite(msOf(schedule.at)))
      throw invalid("A Hermes routine needs an ISO time.");
    return new Date(msOf(schedule.at)).toISOString();
  }
  if (schedule?.kind === "every") {
    const minutes = schedule.everyMs / 60000;
    if (!Number.isSafeInteger(minutes) || minutes < 1)
      throw invalid("A Hermes routine repeats in whole minutes.");
    return `every ${minutes}m`;
  }
  throw new TypeError(`Unknown routine schedule ${schedule?.kind}`);
}

/**
 * The pinned expression a job of a routine in its own time zone needs now, or null
 * when it needs none: its pin names an occurrence that passed (it ran, or it was
 * due while the gateway was down) or no longer the next one; or the routine's own
 * expression for a pinned job whose zone is the one Hermes runs in now. A paused job
 * and one running are left alone.
 */
export function repinOf(job, { zone = processZone(), now = Date.now() } = {}) {
  const meta = job?.[metaField]?.schedule;
  if (job?.schedule?.kind !== "cron" || job.enabled !== true || job.fire_claim)
    return null;
  if (typeof meta?.expression !== "string") return null;
  // A routine in the zone Hermes now runs in (the owner changed the agents' time
  // zone) takes its own expression again instead of a pin to one occurrence.
  if (!zoned(meta.timezone, zone))
    return job.schedule.expr === meta.expression ? null : meta.expression;
  const next = nextCronRun(meta.expression, meta.timezone, now);
  if (next === null) return null;
  const pin = pinnedExpression(next, zone);
  return pin === job.schedule.expr ? null : pin;
}

// A model reference `provider/model` names the model of the agent's own connection.
const modelId = (model) =>
  typeof model === "string" && model ? model.slice(model.indexOf("/") + 1) : undefined;

/** The meta of a routine, or of an update's patch, merged over `old`. */
export function routineMeta(routine, old = {}) {
  const has = (name) => routine[name] !== undefined;
  const prompt = routine.prompt;
  return {
    ...old,
    ...defined([
      ["marker", has("marker") ? routine.marker : undefined],
      ["agentId", routine.agentId],
      ["keepAfterRun", routine.keepAfterRun],
      ["wakeNow", routine.wakeNow],
      ["alertOnFailure", routine.alertOnFailure],
      ["target", routine.target && structuredClone(routine.target)],
      ["delivery", routine.delivery && structuredClone(routine.delivery)],
    ]),
    ...(has("prompt") && {
      prompt: defined([
        ["text", prompt.text],
        ["model", prompt.model],
        ["timeoutSeconds", prompt.timeoutSeconds],
        ["fullContext", prompt.fullContext],
        ["tools", prompt.tools && [...prompt.tools]],
      ]),
    }),
    ...(has("schedule") && {
      schedule: defined([
        ["timezone", routine.schedule.timezone],
        [
          "expression",
          routine.schedule.kind === "cron"
            ? routine.schedule.expression?.trim()
            : undefined,
        ],
        ["at", routine.schedule.kind === "at" ? routine.schedule.at : undefined],
        ["anchorMs", routine.schedule.anchorMs],
      ]),
    }),
    revision: (Number.isSafeInteger(old.revision) ? old.revision : 0) + 1,
  };
}

/**
 * The create body (CronJobCreate) of a routine: always created paused. `options`
 * (`zone`, `now`) as for hermesSchedule.
 */
export function hermesCreate(routine, options) {
  if (!routine.prompt?.text) throw invalid("A Hermes routine needs a prompt.");
  return defined([
    ["name", routine.name],
    ["schedule", hermesSchedule(routine.schedule, options)],
    ["prompt", routine.prompt.text],
    ["model", modelId(routine.prompt.model)],
    ["deliver", "local"],
    ["paused", true],
  ]);
}

/** The update fields (CronJobUpdate `updates`) of a patch, its meta included. */
export function hermesUpdates(patch, meta, options) {
  return {
    ...defined([
      ["name", patch.name],
      ["schedule", patch.schedule && hermesSchedule(patch.schedule, options)],
      ["prompt", patch.prompt?.text],
      ["model", patch.prompt ? (modelId(patch.prompt.model) ?? null) : undefined],
    ]),
    [metaField]: meta,
  };
}

// --- from Hermes ------------------------------------------------------------------

function routineSchedule(schedule, meta = {}) {
  if (schedule?.kind === "cron")
    return defined([
      ["kind", "cron"],
      // A pinned job (another time zone) runs the routine's own expression.
      ["expression", meta.expression ?? schedule.expr],
      ["timezone", meta.timezone],
    ]);
  if (schedule?.kind === "once") {
    // The time as AgentPier gave it while it names the same instant.
    const at =
      meta.at && msOf(meta.at) === msOf(schedule.run_at) ? meta.at : schedule.run_at;
    return { kind: "at", at };
  }
  if (schedule?.kind === "interval" && Number.isFinite(schedule.minutes))
    return defined([
      ["kind", "every"],
      ["everyMs", schedule.minutes * 60000],
      ["anchorMs", meta.anchorMs],
    ]);
  return null;
}

function routinePrompt(job, meta = {}) {
  if (job.no_agent || typeof job.prompt !== "string" || !job.prompt) return null;
  // Hermes trims the prompt: AgentPier's own text while it is the same.
  const text = meta.text?.trim() === job.prompt ? meta.text : job.prompt;
  return defined([
    ["text", text],
    ["model", meta.model ?? (job.model || undefined)],
    ["timeoutSeconds", meta.timeoutSeconds],
    ["fullContext", meta.fullContext],
    ["tools", meta.tools && [...meta.tools]],
  ]);
}

// Hermes's run outcomes (cron/jobs.py _record_run_outcome) as the model's: a run
// whose agent succeeded is "ok" also when Hermes's own delivery failed.
const statusOf = (status) =>
  typeof status !== "string" || !status
    ? undefined
    : ["ok", "delivery_failed"].includes(status)
      ? "ok"
      : status === "skipped"
        ? "skipped"
        : "error";

const runStateOf = (job, delivered) =>
  defined([
    ["nextRunAtMs", msOf(job.next_run_at)],
    ["runningAtMs", msOf(job.fire_claim?.at)],
    ["lastRunAtMs", msOf(job.last_run_at)],
    ["lastStatus", statusOf(job.last_status)],
    ["lastDeliveryStatus", delivered],
    ["lastError", job.last_error || undefined],
    [
      "failuresInRow",
      Number.isSafeInteger(job.failure_streak) ? job.failure_streak : undefined,
    ],
  ]);

/**
 * A Hermes job as a routine; null for an answer that is no job. A job AgentPier did
 * not create (no meta) runs in its own session and delivers nothing to AgentPier.
 * `agentId` is the agent the gateway serves; `delivered` the delivery status of its
 * last run as AgentPier delivered it.
 */
export function routineOfJob(job, { agentId, delivered } = {}) {
  if (!job || typeof job !== "object" || typeof job.id !== "string") return null;
  const meta = job[metaField] && typeof job[metaField] === "object" ? job[metaField] : {};
  return {
    ...defined([
      ["id", job.id],
      ["name", job.name],
      ["agentId", meta.agentId ?? agentId],
      ["enabled", typeof job.enabled === "boolean" ? job.enabled : undefined],
      ["revision", Number.isSafeInteger(meta.revision) ? meta.revision : 0],
      ["keepAfterRun", meta.keepAfterRun],
      ["wakeNow", meta.wakeNow],
      ["alertOnFailure", meta.alertOnFailure],
    ]),
    marker: typeof meta.marker === "string" ? meta.marker : null,
    schedule: routineSchedule(job.schedule, meta.schedule),
    target: meta.target ? structuredClone(meta.target) : { kind: "own" },
    prompt: routinePrompt(job, meta.prompt),
    delivery: meta.delivery ? structuredClone(meta.delivery) : { kind: "none" },
    runState: runStateOf(job, delivered),
  };
}

// --- run sessions -----------------------------------------------------------------

// A routine run's session: `agent:<agent>:hermes:cron:<job>`, per run `…:<session id>`
// (the run's own stored session, which the sessions sub-port reads).
const runSession =
  /^(agent:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):hermes:cron:([A-Za-z0-9_-]{1,64}))(?::([^:\s]{1,200}))?$/;

/** The session key of one run of job `jobId`, stored as `sessionId`. */
export const runSessionKey = (agentId, jobId, sessionId) =>
  `agent:${agentId}:hermes:cron:${jobId}:${sessionId}`;

/** The stored session id a run's session key names, or null. */
export const runSessionId = (key) =>
  runSession.exec(typeof key === "string" ? key : "")?.[4] ?? null;

/**
 * The routine run a Hermes session key names (routines.runOf), or null: `{ agentId,
 * routineId, runId, routineSession }`, `runId` the run's stored session id, null for
 * the routine's own key.
 */
export function hermesCronRunOf(sessionKey) {
  const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
  return match
    ? {
        agentId: match[2],
        routineId: match[3],
        runId: match[4] ?? null,
        routineSession: match[1],
      }
    : null;
}

/** One run row (GET …/runs) as a run record; `last` the job's latest outcome. */
export function routineRun(row, { agentId, jobId, last } = {}) {
  const runAtMs = Number.isFinite(row?.started_at)
    ? Math.round(row.started_at * 1000)
    : undefined;
  const endedMs = Number.isFinite(row?.ended_at)
    ? Math.round(row.ended_at * 1000)
    : undefined;
  const failed = /error|fail/i.test(String(row?.end_reason || ""));
  const id =
    typeof row?.id === "string" && !row.id.startsWith("cron_output:") ? row.id : null;
  return defined([
    ["runAtMs", runAtMs],
    ["status", last ?? (failed ? "error" : "ok")],
    [
      "durationMs",
      runAtMs !== undefined && endedMs !== undefined ? endedMs - runAtMs : undefined,
    ],
    ["sessionKey", id && jobId ? runSessionKey(agentId, jobId, id) : undefined],
  ]);
}
