import { assistantProblem } from "../../assistant-validation.js";
import { boundPort } from "./openclaw-agents.js";
import {
  cronFields,
  cronRunOf,
  routineOfJob,
  routineRun,
} from "./openclaw-routine-jobs.js";

// cron.list pages: 200 jobs each, at most 10000 jobs in all.
const pageSize = 200;
const maxJobs = 10000;

/**
 * The routines sub-port (agent-runtime.js) over OpenClaw's cron scheduler. Callers
 * hand and receive AgentPier's routine model (../../routine-definition.js); each
 * routine is one cron job, translated in openclaw-routine-jobs.js into the job
 * AgentPier submitted before the model existed. What stays here is how the
 * scheduler is driven: the paged listing, the job a creation answers with, a forced
 * run's outcome, the scheduler status and the session keys of routine runs.
 */
export const openClawRoutines = (supervisor, clientOf) =>
  boundPort(routinesOver, supervisor, clientOf);

function routinesOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    // Every routine of `agentId` (every agent's without one), disabled ones included.
    async list({ agentId } = {}) {
      const jobs = [];
      let offset = 0;
      do {
        const page = await call("cron.list", {
          ...(agentId && { agentId }),
          includeDisabled: true,
          limit: pageSize,
          offset,
        });
        if (!Array.isArray(page.jobs)) throw assistantProblem("unavailable", 503);
        jobs.push(...page.jobs);
        if (!page.hasMore) return jobs.map(routineOfJob);
        if (!(page.nextOffset > offset) || jobs.length >= maxJobs)
          throw assistantProblem("unavailable", 503);
        offset = page.nextOffset;
      } while (true);
    },
    // The created routine; OpenClaw answers its job bare or as `{ job }`.
    async add({ routine }) {
      const result = await call("cron.add", cronFields(routine));
      return routineOfJob(result?.job || result);
    },
    // The routine after the change; `patch` names the fields that change.
    update: async ({ id, patch }) =>
      routineOfJob(await call("cron.update", { id, patch: cronFields(patch) })),
    remove: ({ id }) => call("cron.remove", { id }),
    // `force` runs a disabled job or one not due yet.
    async run({ id, force = false }) {
      const result = await call("cron.run", force ? { id, mode: "force" } : { id });
      return { queued: result?.enqueued === true, refused: result?.ran === false };
    },
    // `{ entries }`: the routine's recent runs, at most `limit`.
    async runs({ id, limit }) {
      const result = await call("cron.runs", { id, limit });
      return { entries: (result?.entries || []).map(routineRun) };
    },
    // `{ enabled }`: whether the scheduler runs jobs at all.
    status: () => call("cron.status", {}),
    // Synchronously, the routine run a session key names (`agent:<id>:cron:<job>`).
    runOf: (sessionKey) => cronRunOf(sessionKey),
  };
}
