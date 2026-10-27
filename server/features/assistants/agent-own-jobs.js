import { assistantProblem } from "./assistant-validation.js";

/**
 * Cron jobs an agent made itself in OpenClaw (its own `cron` tool), which AgentPier
 * never bound: every job of AgentPier carries an `agentpier-` declaration key
 * (reminders, routines, check-ins and hook runs). Every archive pauses the agent's own
 * enabled jobs and remembers which (`ownJobs.paused`); every restore enables exactly
 * those again. Both run for every archive path: agent-lifecycle.js and the team
 * lifecycle (team-service.js, through `followArchive`), so a lead's temporary members
 * and the team routes are covered. A step the Gateway could not finish, wholly or in
 * part, stays `pending` with what was already paused and is settled at the next start
 * (`settleOwnJobs`). None of these throws: the archive or restore itself stands.
 */
const ownJob = (job) => !String(job?.declarationKey || "").startsWith("agentpier-");
const code = (error) => error?.code ?? error?.name ?? "UNKNOWN";
const merged = (...lists) => [...new Set(lists.flat())];

/** The `ownJobs` field after pausing: every paused id, and `pending` if not done. */
export async function pauseOwnJobs(assistants, agent) {
  const before = agent.ownJobs?.paused || [];
  const client = assistants.runtime?.client;
  if (!assistants.reminders) return agent.ownJobs ?? null;
  if (!client?.ready) return { pending: "pause", paused: before };
  const paused = [];
  try {
    for (const job of await assistants.reminders.jobs(agent))
      if (ownJob(job) && job.enabled !== false) {
        await client.call("cron.update", { id: job.id, patch: { enabled: false } });
        paused.push(job.id);
      }
  } catch (error) {
    console.warn(`An archived agent's own jobs were not all paused (${code(error)}).`);
    return { pending: "pause", paused: merged(before, paused) };
  }
  const all = merged(before, paused);
  return all.length ? { paused: all } : null;
}

/** The `ownJobs` field after resuming: none, or what is still to enable. */
export async function resumeOwnJobs(assistants, agent) {
  const paused = agent.ownJobs?.paused || [];
  if (!paused.length) return null;
  const client = assistants.runtime?.client;
  if (!client?.ready) return { pending: "resume", paused };
  const left = [...paused];
  try {
    // A job deleted meanwhile stays deleted.
    const listed = new Set((await assistants.reminders.jobs(agent)).map((j) => j.id));
    for (const id of paused) {
      if (listed.has(id))
        await client.call("cron.update", { id, patch: { enabled: true } });
      left.shift();
    }
  } catch (error) {
    console.warn(`A restored agent's own jobs were not all enabled (${code(error)}).`);
    return { pending: "resume", paused: left };
  }
  return null;
}

// Pauses (archived) or resumes the agent's own jobs and stores what is left.
async function follow(assistants, id) {
  const agent = assistants.store.storedAssistant(id);
  if (agent.deletingAt) return;
  const next = agent.archivedAt
    ? await pauseOwnJobs(assistants, agent)
    : await resumeOwnJobs(assistants, agent);
  if (JSON.stringify(next ?? null) !== JSON.stringify(agent.ownJobs ?? null))
    assistants.store.changeUserAgent(id, { ownJobs: next });
}

/**
 * After an archive or restore of `agents` (ids, or team member records with their
 * `assistantId`; agent-lifecycle.js, team-service.js lifecycle): their own jobs
 * follow. One agent's failure never stops the others.
 */
export async function followArchive(assistants, action, agents) {
  if (!["archive", "restore"].includes(action)) return;
  for (const id of agents.map((a) => a.assistantId ?? a))
    await follow(assistants, id).catch((error) =>
      console.warn(`An agent's own jobs were not followed (${code(error)}).`),
    );
}

/** What a start finishes: pauses and resumes that waited for the Gateway. */
export async function settleOwnJobs(assistants) {
  const ids = assistants.store
    .listAssistants()
    .filter((a) => a.ownJobs?.pending && !a.deletingAt)
    .map((a) => a.id);
  await followArchive(assistants, "archive", ids);
}

/** A member being deleted is never archived or restored by its team (team-service.js). */
export function refuseDeleting(store, members) {
  if (members.some((m) => store.storedAssistant(m.assistantId).deletingAt))
    throw assistantProblem("notFound", 404);
}
