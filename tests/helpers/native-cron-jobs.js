/**
 * The pinned Gateway's own cron jobs, read over the supervisor's raw client with
 * OpenClaw's fields (`declarationKey`, `sessionTarget`, `payload`, `state`, …). The
 * native contracts pin what OpenClaw stores and runs; AgentPier itself reads the same
 * jobs as its routine model through the routines sub-port (routine-definition.js).
 * One page is enough for a contract's few jobs.
 */
export async function cronJobs(runtime, agentId, options = { timeoutMs: 60000 }) {
  const { jobs } = await runtime.client.call(
    "cron.list",
    { ...(agentId && { agentId }), includeDisabled: true, limit: 200, offset: 0 },
    options,
  );
  return jobs;
}
