import { assistantProblem } from "./assistant-validation.js";
import { hostConnection, hostReady, runtimeFor } from "./runtimes/runtime-for.js";
import { agentPierRoutine } from "./routine-definition.js";

/**
 * Cron jobs an agent made itself in OpenClaw (its own `cron` tool), which AgentPier
 * never bound: every routine of AgentPier carries a marker of its own
 * (routine-definition.js: reminders, routines, check-ins and hook runs). Every archive pauses the agent's own
 * enabled jobs and remembers which (`ownJobs.paused`); every restore enables exactly
 * those again. Both run for every archive path: agent-lifecycle.js and the team
 * lifecycle (team-service.js, through `followArchive`), so a lead's temporary members
 * and the team routes are covered. A step the Gateway could not finish, wholly or in
 * part, stays `pending` with what was already paused and is settled at the next start
 * (`settleOwnJobs`). None of these throws: the archive or restore itself stands.
 */
const ownJob = (job) => !agentPierRoutine(job);
const code = (error) => error?.code ?? error?.name ?? "UNKNOWN";
const merged = (...lists) => [...new Set(lists.flat())];
// The agent's routines sub-port bound to the runtime's current connection.
// A runtime without routines (Hermes, ADR 0006 step 5) holds no jobs of the agent.
const schedules = (assistants, agent) =>
  runtimeFor(agent, assistants.runtime).capabilities().routines.available;
const boundRoutines = (assistants, agent) =>
  runtimeFor(agent, assistants.runtime).routines.on(hostConnection(assistants.runtime));

/** The `ownJobs` field after pausing: every paused id, and `pending` if not done. */
export async function pauseOwnJobs(assistants, agent) {
  const before = agent.ownJobs?.paused || [];
  if (!assistants.reminders || !schedules(assistants, agent))
    return agent.ownJobs ?? null;
  if (!hostReady(assistants.runtime)) return { pending: "pause", paused: before };
  // The jobs are paused on the connection checked here: a Gateway that replaced it
  // receives none of it, and the archive leaves the pause pending.
  const routines = boundRoutines(assistants, agent);
  const paused = [];
  try {
    for (const job of await assistants.reminders.jobs(agent))
      if (ownJob(job) && job.enabled !== false) {
        await routines.update({ id: job.id, patch: { enabled: false } });
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
  if (!paused.length || !schedules(assistants, agent))
    return paused.length ? agent.ownJobs : null;
  if (!hostReady(assistants.runtime)) return { pending: "resume", paused };
  const routines = boundRoutines(assistants, agent);
  const left = [...paused];
  try {
    // A job deleted meanwhile stays deleted.
    const listed = new Set((await assistants.reminders.jobs(agent)).map((j) => j.id));
    for (const id of paused) {
      if (listed.has(id)) await routines.update({ id, patch: { enabled: true } });
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
