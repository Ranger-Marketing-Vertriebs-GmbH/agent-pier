// AgentPier's routine model (../../routine-definition.js) in OpenClaw's cron jobs and
// back. A routine becomes the cron job AgentPier submitted before the model existed,
// field for field; a job read back keeps only what the model names, so OpenClaw's own
// additions (a cron schedule's `staggerMs`, payload fields AgentPier never sets) stay
// in OpenClaw.

// Only the fields given: a missing field stays missing on the wire.
const defined = (entries) =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined));

// --- to OpenClaw ------------------------------------------------------------------

function cronSchedule(schedule) {
  if (schedule?.kind === "cron")
    return defined([
      ["kind", "cron"],
      ["expr", schedule.expression],
      ["tz", schedule.timezone],
    ]);
  if (schedule?.kind === "at") return { kind: "at", at: schedule.at };
  if (schedule?.kind === "every")
    return defined([
      ["kind", "every"],
      ["everyMs", schedule.everyMs],
      ["anchorMs", schedule.anchorMs],
    ]);
  throw new TypeError(`Unknown routine schedule ${schedule?.kind}`);
}

// OpenClaw's session targets: `current` is the session `sessionKey` names.
function cronTarget(target) {
  if (target?.kind === "chat")
    return defined([
      ["sessionTarget", "current"],
      ["sessionKey", target.sessionKey],
    ]);
  if (target?.kind === "own") return { sessionTarget: "isolated" };
  if (target?.kind === "main") return { sessionTarget: "main" };
  throw new TypeError(`Unknown routine target ${target?.kind}`);
}

const cronPayload = (prompt) =>
  defined([
    ["kind", "agentTurn"],
    ["message", prompt.text],
    ["model", prompt.model],
    ["timeoutSeconds", prompt.timeoutSeconds],
    ["lightContext", prompt.fullContext === undefined ? undefined : !prompt.fullContext],
    ["toolsAllow", prompt.tools && [...prompt.tools]],
  ]);

// Announce commits the result into the target session (no channels are configured);
// its completion destination hands the result to AgentPier.
function cronDelivery(delivery) {
  if (delivery?.kind === "webhook") return { mode: "webhook", to: delivery.url };
  if (delivery?.kind === "chat")
    return {
      mode: "announce",
      ...(delivery.url !== undefined && {
        completionDestination: { mode: "webhook", to: delivery.url },
      }),
    };
  if (delivery?.kind === "none") return { mode: "none" };
  throw new TypeError(`Unknown routine delivery ${delivery?.kind}`);
}

/** The cron fields of a routine, or of a part of one (an update's patch). */
export function cronFields(routine) {
  const has = (name) => routine[name] !== undefined;
  return {
    ...defined([
      ["name", routine.name],
      ["declarationKey", routine.marker ?? undefined],
      ["agentId", routine.agentId],
      ["enabled", routine.enabled],
      ["deleteAfterRun", has("keepAfterRun") ? !routine.keepAfterRun : undefined],
    ]),
    ...(has("schedule") && { schedule: cronSchedule(routine.schedule) }),
    ...defined([
      [
        "wakeMode",
        has("wakeNow") ? (routine.wakeNow ? "now" : "next-heartbeat") : undefined,
      ],
      // Off is all AgentPier asks for; on keeps OpenClaw's own default.
      ["failureAlert", routine.alertOnFailure === false ? false : undefined],
    ]),
    ...(has("target") && cronTarget(routine.target)),
    ...(has("prompt") && { payload: cronPayload(routine.prompt) }),
    ...(has("delivery") && { delivery: cronDelivery(routine.delivery) }),
  };
}

// --- from OpenClaw ----------------------------------------------------------------

function routineSchedule(schedule) {
  if (schedule?.kind === "cron")
    return defined([
      ["kind", "cron"],
      ["expression", schedule.expr],
      ["timezone", schedule.tz],
    ]);
  if (schedule?.kind === "at") return { kind: "at", at: schedule.at };
  if (schedule?.kind === "every")
    return defined([
      ["kind", "every"],
      ["everyMs", schedule.everyMs],
      ["anchorMs", schedule.anchorMs],
    ]);
  return null;
}

function routineTarget(job) {
  if (job.sessionTarget === "current")
    return defined([
      ["kind", "chat"],
      ["sessionKey", job.sessionKey],
    ]);
  if (job.sessionTarget === "isolated") return { kind: "own" };
  if (job.sessionTarget === "main") return { kind: "main" };
  return { kind: "other" };
}

// An agent turn; anything else (a system event an agent scheduled itself) is no prompt.
const routinePrompt = (payload) =>
  payload?.kind === "agentTurn"
    ? defined([
        ["text", payload.message],
        ["model", payload.model],
        ["timeoutSeconds", payload.timeoutSeconds],
        [
          "fullContext",
          typeof payload.lightContext === "boolean" ? !payload.lightContext : undefined,
        ],
        [
          "tools",
          Array.isArray(payload.toolsAllow) ? [...payload.toolsAllow] : undefined,
        ],
      ])
    : null;

function routineDelivery(delivery) {
  // Where the result goes: the completion destination, else the delivery's own.
  const url = delivery?.completionDestination?.to ?? delivery?.to;
  const kind = { webhook: "webhook", announce: "chat", none: "none" }[delivery?.mode];
  if (!delivery) return null;
  return kind === "none"
    ? { kind }
    : defined([
        ["kind", kind || "other"],
        ["url", url],
      ]);
}

const routineRunState = (state = {}) =>
  defined([
    ["nextRunAtMs", state.nextRunAtMs],
    ["runningAtMs", state.runningAtMs],
    ["lastRunAtMs", state.lastRunAtMs],
    // `lastStatus` is the older name of `lastRunStatus`.
    ["lastStatus", state.lastRunStatus ?? state.lastStatus],
    ["lastDeliveryStatus", state.lastDeliveryStatus],
    ["lastError", state.lastError],
    ["lastErrorReason", state.lastErrorReason],
    ["failuresInRow", state.consecutiveErrors],
  ]);

/** A cron job as a routine; null for an answer that is no job. */
export function routineOfJob(job) {
  if (!job || typeof job !== "object") return null;
  return {
    ...defined([
      ["id", job.id],
      ["name", job.name],
      ["agentId", job.agentId],
      ["enabled", typeof job.enabled === "boolean" ? job.enabled : undefined],
      ["revision", job.updatedAtMs],
      [
        "keepAfterRun",
        typeof job.deleteAfterRun === "boolean" ? !job.deleteAfterRun : undefined,
      ],
      ["wakeNow", job.wakeMode === undefined ? undefined : job.wakeMode === "now"],
      [
        "alertOnFailure",
        job.failureAlert === undefined ? undefined : job.failureAlert !== false,
      ],
    ]),
    marker: typeof job.declarationKey === "string" ? job.declarationKey : null,
    schedule: routineSchedule(job.schedule),
    target: routineTarget(job),
    prompt: routinePrompt(job.payload),
    delivery: routineDelivery(job.delivery),
    runState: routineRunState(job.state),
  };
}

/** One cron.runs entry as a routine run record. */
export const routineRun = (entry = {}) =>
  defined([
    ["runAtMs", entry.runAtMs],
    ["status", entry.status],
    ["completionStatus", entry.completionStatus],
    ["deliveryStatus", entry.deliveryStatus],
    ["durationMs", entry.durationMs],
    ["error", entry.error],
    ["errorReason", entry.errorReason],
    ["sessionKey", entry.sessionKey],
  ]);

// A run's session: `agent:<agent>:cron:<job>`, per run `…:run:<id>`.
const runSession = /^(agent:([^:]+):cron:([^:]+))(?::run:([^:]+))?$/i;

/**
 * The routine run a session key names, or null: `{ agentId, routineId, runId,
 * routineSession }`, `runId` null for the job's own session, which serves the
 * transcript of its latest run.
 */
export function cronRunOf(sessionKey) {
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
