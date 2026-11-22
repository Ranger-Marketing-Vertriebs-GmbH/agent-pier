// Check-ins and routines that commit into a chat follow that chat across an owner's
// `/reset` or `/new` (sent from Telegram; the web chat answers both itself).
//
// OpenClaw 2026.11.3, the rollback target, records the chat's lifecycle revision when
// a job with a chat target is created (`sourceConversation`, which openclaw#167363 introduced
// for isolated jobs) and refuses to commit a run's result into a later revision of that
// chat ("session rebound for sessionKey …", `not-delivered`). A reset rotates the
// revision (the session id stays); compaction keeps it. `cron.update` never records
// it again and there is no other public way to rebind, so the job is re-created: the
// same fields, a new id. 2026.11.6 lets automations follow the chat again
// (openclaw#199512): there `pinsChat` (openclaw-routines.js) answers false and
// nothing here runs. Remove this module once 2026.11.3 is no rollback target.
//
// The binding keeps its id; its earlier job ids stay its own (`previousNativeIds`),
// so a late completion of the old job is accepted and the run history goes on. A
// re-creation is recorded on the binding before the old job is removed (`rebind`),
// and the next sync finishes one that a lost Gateway left half done.

const kinds = new Set(["heartbeat", "routine"]);
const keptIds = 8;

/** Whether a run's result was refused because the chat was reset since the job. */
export const sessionRebound = (event) =>
  event?.deliveryStatus === "not-delivered" &&
  typeof event.deliveryError === "string" &&
  event.deliveryError.startsWith("session rebound for sessionKey");

/** Whether `jobId` is the binding's job, now or before a re-creation. */
export const ownsRun = (binding, jobId) =>
  typeof jobId === "string" &&
  (binding.nativeId === jobId || (binding.previousNativeIds ?? []).includes(jobId));

/**
 * Re-creates the jobs of every check-in and routine that commit into the
 * conversation, on a runtime that pins the chat (no-op elsewhere). `at`: when the
 * reset or the refused run happened; a job re-created since then already follows the
 * chat (`reboundAt`). A job with a run under way is left alone: its commit fails, and
 * that failure rebinds it. `refused` (`{ jobId, runAtMs }`) is that failure: its job
 * is rebound even while its refused run still shows as running. Callers hold
 * admission. Returns how many jobs were re-created.
 */
export async function followChat(reminders, conversationId, { at, refused } = {}) {
  const { store } = reminders.assistants;
  const conversation = store.getConversation(conversationId);
  const key = conversation?.runtimeSessionKey;
  if (!key || conversation.archivedAt) return 0;
  const agent = store.getAssistant(conversation.assistantId);
  if (!reminders.scheduler(agent).pinsChat?.()) return 0;
  const bindings = reminders.bindings
    .list(agent.id)
    .filter((b) => kinds.has(b.kind) && b.state === "bound")
    .filter((b) => !(at <= b.reboundAt));
  if (!bindings.length) return 0;
  const jobs = await reminders.jobs(agent);
  let count = 0;
  // The refused run itself, still shown as running, or a later run.
  const running = (job) =>
    Number.isFinite(job.runState?.runningAtMs) &&
    !(job.id === refused?.jobId && job.runState.runningAtMs <= refused.runAtMs);
  for (const binding of bindings) {
    const job = reminders.find(binding, jobs);
    if (
      job?.target?.kind !== "chat" ||
      job.target.sessionKey !== key ||
      job.delivery?.kind !== "chat" ||
      running(job)
    )
      continue;
    await rebindJob(reminders, agent, binding, job);
    count += 1;
  }
  if (count) reminders.assistants.changed();
  return count;
}

/**
 * Re-creates `job` of `binding` with `patch` applied, so it records its chat as it
 * is now. Returns the new routine.
 */
export async function rebindJob(reminders, agent, binding, job, patch = {}) {
  const {
    id: _id,
    revision: _revision,
    runState: _runState,
    ...routine
  } = {
    ...job,
    ...patch,
  };
  reminders.bindings.patch(binding.id, { rebind: { from: job.id, routine } });
  return finishRebind(reminders, agent, reminders.bindings.get(binding.id), [job]);
}

/**
 * Finishes a re-creation recorded on the binding: removes the old job if it is still
 * listed, adds the new one unless a listing shows it already (by its marker; one
 * without a marker is always added). `jobs` are the agent's routines as just read.
 * Returns the new routine, or null with none pending.
 */
export async function finishRebind(reminders, agent, binding, jobs) {
  const pending = binding.rebind;
  if (!pending) return null;
  const scheduler = reminders.scheduler(agent);
  const { marker } = pending.routine;
  let next = marker && jobs.find((j) => j.marker === marker && j.id !== pending.from);
  if (!next) {
    if (jobs.some((j) => j.id === pending.from))
      await scheduler.remove({ id: pending.from });
    next = await scheduler.add({ routine: pending.routine });
    if (!next?.id) throw Error("The re-created job has no id.");
  }
  const earlier = (binding.previousNativeIds ?? []).filter((i) => i !== pending.from);
  reminders.bindings.patch(binding.id, {
    nativeId: next.id,
    previousNativeIds: [pending.from, ...earlier].slice(0, keptIds),
    rebind: null,
    reboundAt: Date.now(),
  });
  return next;
}

/** Finishes every re-creation of the agent's bindings that is still pending. */
export async function finishRebinds(reminders, agent, jobs) {
  for (const binding of reminders.bindings.list(agent.id))
    if (binding.rebind && kinds.has(binding.kind))
      await finishRebind(reminders, agent, binding, jobs).catch(() => {});
}

/** The binding's recent runs, its earlier jobs' included, newest first. */
export async function bindingRuns(scheduler, binding, limit = 20) {
  const ids = [binding.nativeId, ...(binding.previousNativeIds ?? [])].filter(Boolean);
  const pages = await Promise.all(
    ids.map((id, n) =>
      scheduler.runs({ id, limit }).catch((error) => {
        // Earlier jobs are history only; the current job's read must succeed.
        if (n === 0) throw error;
        return { entries: [] };
      }),
    ),
  );
  return pages
    .flatMap((page) => page.entries || [])
    .sort((a, b) => (b.runAtMs ?? 0) - (a.runAtMs ?? 0))
    .slice(0, limit);
}
