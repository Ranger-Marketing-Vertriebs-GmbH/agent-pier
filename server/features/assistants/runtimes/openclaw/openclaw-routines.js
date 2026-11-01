import { assistantProblem } from "../../assistant-validation.js";
import { boundPort } from "./openclaw-agents.js";

// cron.list pages: 200 jobs each, at most 10000 jobs in all.
const pageSize = 200;
const maxJobs = 10000;

/**
 * The routines sub-port (agent-runtime.js) over OpenClaw's cron scheduler. Jobs are
 * OpenClaw's own (`id`, `declarationKey`, `schedule`, `payload`, `delivery`,
 * `sessionTarget`, `enabled`, `updatedAtMs`, `state`, …): AgentPier builds and reads
 * them as before the port. What stays here is how the scheduler is driven: the paged
 * listing, the job a creation answers with, a forced run's outcome and the scheduler
 * status.
 */
export const openClawRoutines = (supervisor, clientOf) =>
  boundPort(routinesOver, supervisor, clientOf);

function routinesOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    // Every job of `agentId` (every agent's without one), disabled ones included.
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
        if (!page.hasMore) return jobs;
        if (!(page.nextOffset > offset) || jobs.length >= maxJobs)
          throw assistantProblem("unavailable", 503);
        offset = page.nextOffset;
      } while (true);
    },
    // The created job; OpenClaw answers it bare or as `{ job }`.
    async add({ job }) {
      const result = await call("cron.add", job);
      return result?.job || result;
    },
    // The job after the change.
    update: ({ id, patch }) => call("cron.update", { id, patch }),
    remove: ({ id }) => call("cron.remove", { id }),
    // `force` runs a disabled job or one not due yet.
    async run({ id, force = false }) {
      const result = await call("cron.run", force ? { id, mode: "force" } : { id });
      return { queued: result?.enqueued === true, refused: result?.ran === false };
    },
    // `{ entries }`: the job's recent runs, at most `limit`.
    runs: ({ id, limit }) => call("cron.runs", { id, limit }),
    // `{ enabled }`: whether the scheduler runs jobs at all.
    status: () => call("cron.status", {}),
  };
}
