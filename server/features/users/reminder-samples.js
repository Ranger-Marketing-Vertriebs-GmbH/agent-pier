// One Gateway read of an agent's reminder cron jobs per interval for every user who
// watches that agent's `me.reminders` (live-me-topics.js). A reminder write drops the
// agent's sample (forgetReminderSamples, from agentRemindersChanged), so the reads
// it sets off ask the Gateway themselves and never show the jobs from before it.
import { digestOf } from "../live/live-rows.js";
import { readStamp } from "../../lib/read-stamp.js";

// Her reminders' cron jobs live in the Gateway, like the owner's (agent.reminders).
export const ME_REMINDERS_SAMPLE_MS = 30000;
// How long a sample answers the reads it set off (their debounce is 150 ms to 1 s).
const SAMPLE_FRESH_MS = 2000;

// Every sampler of this process, for forgetReminderSamples.
const samplers = new Set();

/** Agents `ids` (every agent for an empty list) had a reminder write: drop samples. */
export function forgetReminderSamples(ids = []) {
  for (const sampler of samplers) sampler.forget(ids);
}

/**
 * The Gateway's cron jobs of each watched agent, sampled once per `sampleMs` for all
 * users together: `watch(agentId, listener)` calls `listener` when the jobs changed
 * (or the sample failed); `sample(agentId)` hands `{jobs, readAt}` of a sample younger
 * than `freshMs`, and taken after the agent's last reminder write, to the reads that
 * change set off, so they do not ask the Gateway again. `readAt` is the read stamp
 * from before the Gateway was asked: a push of it is never newer than the sample.
 */
export function sharedReminderJobs(
  services,
  {
    sampleMs = ME_REMINDERS_SAMPLE_MS,
    freshMs = SAMPLE_FRESH_MS,
    now = Date.now,
    timers = { setInterval, clearInterval },
    // The agent's cron jobs in the Gateway, read under the agent services' admission.
    readJobs = (agentId) => {
      const reminders = services.assistantReminders;
      return reminders.assistants.admit(async () =>
        reminders.jobs(reminders.agent(agentId)),
      );
    },
  } = {},
) {
  const agents = new Map();
  const sample = async (agentId, entry) => {
    const generation = entry.generation;
    const readAt = readStamp();
    let jobs = null;
    try {
      jobs = await readJobs(agentId);
    } catch {
      // The users' own reads ask again and answer with the refusal.
    }
    if (agents.get(agentId) !== entry) return;
    // A write while the Gateway answered: this sample may predate it.
    entry.sampled =
      jobs && generation === entry.generation ? { at: now(), jobs, readAt } : null;
    const digest = jobs ? digestOf(jobs) : "failed";
    if (digest === entry.digest) return;
    entry.digest = digest;
    for (const listener of [...entry.listeners]) listener();
  };
  const sampler = {
    watch(agentId, listener) {
      let entry = agents.get(agentId);
      if (!entry) {
        entry = { listeners: new Set(), digest: undefined, sampled: null, generation: 0 };
        entry.timer = timers.setInterval(() => sample(agentId, entry), sampleMs);
        entry.timer?.unref?.();
        agents.set(agentId, entry);
        samplers.add(sampler);
      }
      const own = () => listener();
      entry.listeners.add(own);
      return () => {
        if (!entry.listeners.delete(own) || entry.listeners.size) return;
        timers.clearInterval(entry.timer);
        if (agents.get(agentId) === entry) agents.delete(agentId);
        if (!agents.size) samplers.delete(sampler);
      };
    },
    sample(agentId) {
      const sampled = agents.get(agentId)?.sampled;
      return sampled && now() - sampled.at <= freshMs
        ? { jobs: sampled.jobs, readAt: sampled.readAt }
        : undefined;
    },
    forget(ids) {
      for (const [agentId, entry] of agents)
        if (!ids.length || ids.includes(agentId)) {
          entry.sampled = null;
          entry.generation += 1;
        }
    },
  };
  return sampler;
}
