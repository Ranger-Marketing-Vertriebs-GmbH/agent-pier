// The live `me.*` topics: what a restricted user's app follows instead of her former
// event stream. Each topic's value is exactly what its /api/me route answers her
// (route-access.js lists each topic next to that route):
// - `me.agents`: GET /api/me/agents, her agents with her main chat and its activity;
// - `me.account`: GET /api/me, her account and whether the owner reads her chats;
// - `me.approvals`: GET /api/me/approvals, the approvals waiting for her;
// - `me.chats:<agentId>`: GET /api/me/agents/:id/chats, her open chats with the agent;
// - `me.telegram:<agentId>`: GET /api/me/agents/:id/telegram, her own bot (her own
//   agent at Extended only, like the route);
// - `me.reminders:<agentId>`: GET /api/me/agents/:id/reminders, her reminders.
// Only a restricted user subscribes, and an agent topic only for an agent that serves
// her (user-scope.js); everyone else, the owner included, gets unknown-topic. Every
// instance is scoped to one user (`user:<userId>`), so two users never share a read,
// a value, a revision or a frame, also on a shared agent. Her agent taken away (or
// agents switched off) sends `revoked` at once: live-wiring.js checks every
// subscription again on each agent change.
import { agentView } from "../../http/routes/me-agents.js";
import { telegramView, userChannel } from "../../http/routes/me-telegram.js";
import { awaitingForUser } from "./approval-audience.js";
import { canPairTelegram } from "./user-access.js";
import { AGENT_PARAM } from "../assistants/live-topics.js";
import { digestOf } from "../live/live-rows.js";
import { followAgentSwitch, notRunning } from "../assistants/live-runtime-topics.js";

// Her reminders' cron jobs live in the Gateway, like the owner's (agent.reminders):
// one read per agent and interval serves every user who watches that agent's.
export const ME_REMINDERS_SAMPLE_MS = 30000;
// How long a sample answers the reads it set off (their debounce is 150 ms to 1 s).
const SAMPLE_FRESH_MS = 2000;

export const ME_TOPICS = Object.freeze([
  "me.agents",
  "me.account",
  "me.approvals",
  "me.chats",
  "me.telegram",
  "me.reminders",
]);

const user = (principal) =>
  principal?.role === "user" && typeof principal.userId === "string";

/** The agent `agentId` if it serves the restricted user `principal`, else null. */
const agentOf = (services, principal, agentId) =>
  (user(principal) &&
    (services.userScope?.agentsFor(principal.userId) || []).find(
      (a) => a.id === agentId,
    )) ||
  null;

/** The current agent services, or the routes' refusal (404 off, 503 not running). */
function running(services) {
  if (!services.assistants) throw notRunning(Boolean(services.assistantFeature?.enabled));
  return services.assistants;
}

// A refusal of her route (an agent gone, a level too low) is its answer, not a fault:
// the hub does not log it, and her app reads the route once to show it.
const expected = (error) => {
  if (error && typeof error === "object" && Number.isInteger(error.status))
    error.expected = true;
  return error;
};

/**
 * Calls `listener` on every event of the current agent services (a change, a chat's
 * activity, the runtime) and once each time agents are switched on or off, after
 * binding to the services that are current then. `onSwitch(listener)` follows the
 * switch (default: followAgentSwitch). Returns the stop function.
 */
export function followAgentEvents(
  services,
  listener,
  onSwitch = (changed) => followAgentSwitch(services, changed),
) {
  let unbind = null;
  const bind = () => {
    unbind?.();
    unbind = services.assistants?.events?.subscribe(() => listener()) || null;
  };
  bind();
  const unswitch = onSwitch(() => {
    bind();
    listener();
  });
  return () => {
    unbind?.();
    unbind = null;
    unswitch?.();
  };
}

/**
 * One change source shared by every instance that follows it: `follow(fanout)`
 * binds a single listener to its emitters while at least one instance watches, and
 * each event reaches every watching instance. Each user has her own instances, so
 * one emitter listener per instance would grow with users and tabs. Returns
 * `watch(listener)`, which returns the stop function.
 */
export function sharedSource(follow) {
  const listeners = new Set();
  let stop = null;
  const fanout = () => {
    for (const listener of [...listeners]) listener();
  };
  return (listener) => {
    const entry = () => listener();
    listeners.add(entry);
    if (!stop) stop = follow(fanout) || (() => {});
    return () => {
      if (!listeners.delete(entry) || listeners.size) return;
      const stopping = stop;
      stop = null;
      stopping();
    };
  };
}

/**
 * The Gateway's cron jobs of each watched agent, sampled once per `sampleMs` for all
 * users together: `watch(agentId, listener)` calls `listener` when the jobs changed
 * (or the sample failed), `jobs(agentId)` hands a sample younger than `freshMs` to
 * the reads that change set off, so they do not ask the Gateway again.
 */
export function sharedReminderJobs(
  services,
  {
    sampleMs = ME_REMINDERS_SAMPLE_MS,
    freshMs = SAMPLE_FRESH_MS,
    now = Date.now,
    timers = { setInterval, clearInterval },
  } = {},
) {
  const agents = new Map();
  const sample = async (agentId, entry) => {
    let jobs = null;
    try {
      jobs = await services.assistantReminders.agentJobs(agentId);
    } catch {
      // The users' own reads ask again and answer with the refusal.
    }
    if (agents.get(agentId) !== entry) return;
    entry.sampled = jobs && { at: now(), jobs };
    const digest = jobs ? digestOf(jobs) : "failed";
    if (digest === entry.digest) return;
    entry.digest = digest;
    for (const listener of [...entry.listeners]) listener();
  };
  return {
    watch(agentId, listener) {
      let entry = agents.get(agentId);
      if (!entry) {
        entry = { listeners: new Set(), digest: undefined, sampled: null };
        entry.timer = timers.setInterval(() => sample(agentId, entry), sampleMs);
        entry.timer?.unref?.();
        agents.set(agentId, entry);
      }
      const own = () => listener();
      entry.listeners.add(own);
      return () => {
        if (!entry.listeners.delete(own) || entry.listeners.size) return;
        timers.clearInterval(entry.timer);
        if (agents.get(agentId) === entry) agents.delete(agentId);
      };
    },
    jobs(agentId) {
      const sampled = agents.get(agentId)?.sampled;
      return sampled && now() - sampled.at <= freshMs ? sampled.jobs : undefined;
    },
  };
}

function meTopic(services, { name, param = false, mayWatch, read, watch }) {
  const admitted = (principal, agentId) => {
    if (!param) return user(principal);
    const agent = agentOf(services, principal, agentId);
    return !!agent && (!mayWatch || mayWatch(agent, principal.userId));
  };
  return {
    name,
    mode: "state",
    ...(param && { param: AGENT_PARAM }),
    authorize: admitted,
    scopeKey: (principal) => `user:${principal.userId}`,
    async read(principal, agentId) {
      // Checked again per read: a read never answers for an agent she lost.
      if (!admitted(principal, agentId)) {
        running(services);
        throw expected(services.userScope.refusal());
      }
      try {
        return await read(principal, agentId);
      } catch (error) {
        throw expected(error);
      }
    },
    watch: ({ invalidate, param: agentId }) => watch(() => invalidate(), agentId),
  };
}

/** The `me.*` topic definitions for LiveHub#define. */
export function meTopics(services, { reminderJobs = sharedReminderJobs(services) } = {}) {
  // One emitter listener per source for all users' instances together.
  const agentSwitch = sharedSource((fanout) => followAgentSwitch(services, fanout));
  const agentEvents = sharedSource((fanout) =>
    followAgentEvents(services, fanout, agentSwitch),
  );
  const privacy = sharedSource((fanout) => {
    const source = services.ownerPrivacy;
    source?.on("changed", fanout);
    return () => source?.off("changed", fanout);
  });
  return [
    meTopic(services, {
      name: "me.agents",
      watch: agentEvents,
      // Without agent services her list is empty, as the route answers.
      read: (principal) => {
        const assistants = services.assistants;
        if (!assistants) return [];
        return services.userScope
          .agentsFor(principal.userId)
          .map((agent) => agentView(assistants, agent, principal.userId));
      },
    }),
    meTopic(services, {
      name: "me.account",
      read: (principal) => {
        const { id, username, displayName, ownerMayRead } = services.users.get(
          principal.userId,
        );
        return { user: { id, username, displayName }, ownerMayRead };
      },
      // The owner turned reading her chats on or off.
      watch: privacy,
    }),
    meTopic(services, {
      name: "me.approvals",
      // A chat she left takes its approvals with it; decisions are action writes.
      watch: agentEvents,
      read: (principal) => {
        const assistants = running(services);
        const actions = awaitingForUser(
          { assistants, userScope: services.userScope },
          principal,
        );
        return { actions: actions.map((action) => assistants.workflows.project(action)) };
      },
    }),
    meTopic(services, {
      name: "me.chats",
      param: true,
      // A chat's activity and busy state change without naming its agent.
      watch: agentEvents,
      read: (principal, agentId) =>
        running(services).chats.list(agentId, { userId: principal.userId }),
    }),
    meTopic(services, {
      name: "me.telegram",
      param: true,
      // Her own agent at Extended only, as the route: below it the topic is revoked.
      mayWatch: canPairTelegram,
      // Every channel write signals it (agentChannelsChanged); her access is checked
      // again on each agent change (live-wiring.js), so agent events read nothing.
      watch: agentSwitch,
      read: (principal, agentId) => ({
        channel: telegramView(
          userChannel(
            running(services),
            services.assistantChannels,
            agentId,
            principal.userId,
          ),
        ),
      }),
    }),
    meTopic(services, {
      name: "me.reminders",
      param: true,
      // Reminder writes and releases signal it (agentRemindersChanged); the Gateway's
      // own changes (a reminder ran) come from the agent's shared sample.
      watch: (listener, agentId) => {
        const stops = [agentSwitch(listener), reminderJobs.watch(agentId, listener)];
        return () => stops.forEach((stop) => stop());
      },
      read: (principal, agentId) => {
        running(services);
        return services.assistantReminders.list(agentId, {
          userId: principal.userId,
          jobs: reminderJobs.jobs(agentId),
        });
      },
    }),
  ];
}
