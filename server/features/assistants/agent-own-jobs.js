/**
 * Cron jobs an agent made itself in OpenClaw (its own `cron` tool), which AgentPier
 * never bound: every job of AgentPier carries an `agentpier-` declaration key
 * (reminders, routines, check-ins and hook runs). Archive pauses the agent's own
 * enabled jobs and remembers which; restore enables exactly those again. Without a
 * running Gateway the step waits (`ownJobs.pending`) for the next start
 * (agent-lifecycle.js resume).
 */
const ownJob = (job) => !String(job?.declarationKey || "").startsWith("agentpier-");

/** The `ownJobs` field after an archive: the paused ids, or the pending pause. */
export async function pauseOwnJobs(assistants, agent) {
  const client = assistants.runtime?.client;
  if (!assistants.reminders) return null;
  if (!client?.ready) return { pending: "pause" };
  const paused = [];
  for (const job of await assistants.reminders.jobs(agent))
    if (ownJob(job) && job.enabled !== false) {
      await client.call("cron.update", { id: job.id, patch: { enabled: false } });
      paused.push(job.id);
    }
  return paused.length ? { paused } : null;
}

/** The `ownJobs` field after a restore: none, or the resume still pending. */
export async function resumeOwnJobs(assistants, agent) {
  const paused = agent.ownJobs?.paused || [];
  if (!paused.length) return null;
  const client = assistants.runtime?.client;
  if (!client?.ready) return { pending: "resume", paused };
  const listed = new Set((await assistants.reminders.jobs(agent)).map((job) => job.id));
  // A job deleted meanwhile stays deleted.
  for (const id of paused)
    if (listed.has(id))
      await client.call("cron.update", { id, patch: { enabled: true } });
  return null;
}

/** What a start finishes: a pause or resume that waited for the Gateway. */
export async function settleOwnJobs(assistants) {
  const { store } = assistants;
  for (const agent of store.listAssistants()) {
    const pending = agent.ownJobs?.pending;
    if (!pending || agent.deletingAt) continue;
    const next = agent.archivedAt
      ? await pauseOwnJobs(assistants, agent)
      : await resumeOwnJobs(assistants, agent);
    store.changeUserAgent(agent.id, { ownJobs: next });
  }
}
