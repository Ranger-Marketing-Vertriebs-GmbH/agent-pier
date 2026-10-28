// The live `agent.list` topic: the owner's agent list that the sidebar, the agents
// page and the settings read, as rows (the browser rebuilds them with applyListSync).
// Its value is the GET /api/assistants body plus `runtime`, the
// GET /api/assistant-runtime answer. Every `change` and `runtime` event of the
// current agent services reads it again (the hub debounces a burst into one read and
// pushes only a changed list as a delta). Agents switched on or off replace those
// services: the topic binds to the new ones and reads again. Without agent services
// it refuses like the routes (404 off, 503 not running), marked `expected` so the hub
// does not log it. Owner only.
import { runtimeView } from "./runtime-view.js";
import { followAgentSwitch, notRunning } from "./live-runtime-topics.js";
import { agentPerson } from "./reminder-audience.js";
import { ownerActionList } from "../users/approval-audience.js";

// The former event stream cut a reader off at 1 MiB; a larger list goes `stale` and
// the browser reads it over REST.
export const AGENT_LIST_MAX_BYTES = 1048576;

/** The agent list of `service` with its runtime view. */
export function agentListOf(service) {
  return {
    ...service.list(),
    runtime: runtimeView({
      runtime: service.runtime,
      assistants: service,
      bridge: service.teams?.bridge,
      webTools: service.webTools,
    }),
  };
}

/**
 * Calls `listener` on every `change` and `runtime` event of the current agent
 * services and once each time agents are switched on or off, after binding to the
 * services that are current then. Returns the stop function.
 */
export function followAgentList(services, listener) {
  let unbind = null;
  const bind = () => {
    unbind?.();
    unbind =
      services.assistants?.events?.subscribe((event) => {
        if (event?.type === "change" || event?.type === "runtime") listener();
      }) || null;
  };
  bind();
  const unswitch = followAgentSwitch(services, () => {
    bind();
    listener();
  });
  return () => {
    unbind?.();
    unbind = null;
    unswitch?.();
  };
}

/** The topic definition for LiveHub#define. */
export function agentListTopic(services) {
  return {
    name: "agent.list",
    mode: "rows",
    maxBytes: AGENT_LIST_MAX_BYTES,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read() {
      const service = services.assistants;
      if (!service) throw notRunning(Boolean(services.assistantFeature?.enabled));
      return agentListOf(service);
    },
    watch: ({ invalidate }) => followAgentList(services, () => invalidate()),
  };
}

// The agent detail topics, `<name>:<agentId>`, owner only. Each one's value is what
// its REST route answers (the browser's fallback reads that route):
// - `agent.actions`: GET /api/assistants/:id/actions;
// - `agent.coding-requests`: that list's team coding requests (`teamId`) only;
// - `agent.channels`: GET /api/assistant-channels with the agent's channels only;
// - `agent.reminders`: GET /api/assistants/:id/reminders;
// - `agent.senders`: GET /api/assistant-telegram-senders/:id.
// Privacy is checked as the routes check it. The owner-content guard
// (owner-content-guard.js) refuses the actions and reminders of a user's own agent
// without her opt-in like an unknown route: so do the topics, and an opt-in that ends
// sends `revoked` (live-wiring.js checks every subscription again on each privacy and
// agent change). The channel list is never refused: like its route, it hides her
// Telegram identity and texts without the opt-in (OwnerPrivacy#filterChannels), so an
// opt-in that ends pushes the list without them. The sender bots are not content:
// their route has no privacy check (user agents never own one).
export const AGENT_DETAIL_TOPICS = Object.freeze([
  "agent.actions",
  "agent.coding-requests",
  "agent.channels",
  "agent.reminders",
  "agent.senders",
]);
// An agent id (randomUUID, or a test's own); never a path or a second parameter.
export const AGENT_PARAM = /[A-Za-z0-9][A-Za-z0-9_-]{0,99}/;
// The bot's state lives in the Gateway (channels.status), which announces nothing:
// it is sampled while a visible tab watches, at the settings' former poll.
export const AGENT_SENDERS_SAMPLE_MS = 5000;
// The cron jobs behind the reminders live in the Gateway too: an agent's own cron
// tool changes them, and a next run moves on without AgentPier hearing of it.
export const AGENT_REMINDERS_SAMPLE_MS = 30000;

const owner = (principal) => principal?.role === "owner";

/**
 * Whether the owner may read agent `id`'s content, as the owner-content guard decides
 * a GET of an `agent` route: without agent services or privacy rules, and for an
 * unknown agent (the route's own 404), the guard lets the request through.
 */
export function ownerReadsAgent(services, id) {
  const { assistants, ownerPrivacy } = services;
  if (!assistants || !ownerPrivacy) return true;
  let agent;
  try {
    agent = assistants.store.getAssistant(id);
  } catch {
    return true;
  }
  return ownerPrivacy.agentContent(agent) === true;
}

// The guard's answer to a refused read: a 404 like an unknown route.
const notFound = () =>
  Object.assign(new Error("Not found."), { status: 404, expected: true });

// A refusal of the agent services (an unknown agent, the Gateway not ready) is the
// route's answer, not a fault: the hub does not log it (live-wiring.js).
function refusal(error) {
  if (error && typeof error === "object" && error.key && Number.isInteger(error.status))
    error.expected = true;
  return error;
}

/** The current agent services, or the routes' refusal (404 off, 503 not running). */
function running(services) {
  if (!services.assistants) throw notRunning(Boolean(services.assistantFeature?.enabled));
  return services.assistants;
}

function actionList(services, id) {
  const assistants = running(services);
  if (!assistants.workflows) throw assistantUnavailable();
  return ownerActionList(assistants.workflows, assistants.store, id);
}

const assistantUnavailable = () =>
  Object.assign(new Error("The agent workflows are not available."), {
    status: 503,
    expected: true,
  });

/**
 * One detail topic. `content`: the owner-content guard decides it, checked when
 * subscribing, on every privacy or agent change and before every read. `privacy`:
 * its value depends on owner privacy, so a privacy change resets it at once
 * (live-wiring.js, LiveHub#resetWhere).
 */
function detailTopic(
  services,
  { name, content = false, privacy = content, read, watch, sampleMs },
) {
  return {
    name,
    mode: "state",
    param: AGENT_PARAM,
    privacy,
    ...(sampleMs && { sampleMs }),
    authorize: (principal, id) =>
      owner(principal) && (!content || ownerReadsAgent(services, id)),
    scopeKey: () => "owner",
    async read(_principal, id) {
      running(services);
      if (content && !ownerReadsAgent(services, id)) throw notFound();
      try {
        return await read(id);
      } catch (error) {
        throw refusal(error);
      }
    },
    watch: ({ invalidate }) => watch(() => invalidate()),
  };
}

/** The agent detail topic definitions for LiveHub#define. */
export function agentDetailTopics(services) {
  const switched = (listener) => followAgentSwitch(services, listener);
  return [
    detailTopic(services, {
      name: "agent.actions",
      content: true,
      read: (id) => actionList(services, id),
      watch: switched,
    }),
    detailTopic(services, {
      name: "agent.coding-requests",
      content: true,
      read: (id) => ({
        actions: actionList(services, id).actions.filter((a) => a.teamId),
      }),
      watch: switched,
    }),
    detailTopic(services, {
      name: "agent.channels",
      // The list hides a user's channel without her opt-in: a privacy change
      // resets it before anything else is sent.
      privacy: true,
      read: (id) => channelsOf(services, id),
      watch: switched,
    }),
    detailTopic(services, {
      name: "agent.reminders",
      content: true,
      read: (id) => {
        const assistants = running(services);
        return services.assistantReminders.list(id, {
          userId: agentPerson(assistants.store.getAssistant(id)),
        });
      },
      // Reminder writes and run results signal it once they are done
      // (followReminderWrites), channel writes its Telegram delivery state; what
      // changes inside the Gateway only is sampled.
      sampleMs: AGENT_REMINDERS_SAMPLE_MS,
      watch: switched,
    }),
    detailTopic(services, {
      name: "agent.senders",
      sampleMs: AGENT_SENDERS_SAMPLE_MS,
      read: (id) => services.assistantTelegramSenders.get(id),
      // A save ends with an agent change, a Gateway restart with a runtime event.
      watch: (listener) => followAgentList(services, listener),
    }),
  ];
}

/** The agent's channels as GET /api/assistant-channels shows them to the owner. */
function channelsOf(services, id) {
  const assistants = running(services);
  assistants.store.getAssistant(id);
  const channels = services.assistantChannels;
  const list = services.ownerPrivacy
    ? services.ownerPrivacy.filterChannels(channels.list(), (conversationId) =>
        assistants.store.getConversation(conversationId),
      )
    : channels.list();
  return { ...list, channels: list.channels.filter((c) => c.assistantId === id) };
}

/**
 * The actions of agents `ids` changed (AssistantWorkflows' onChange): signals their
 * action topics on `hub` (services.live). A failing hub is logged; the write stands.
 */
export function agentActionsChanged(hub, ids) {
  try {
    for (const id of ids) {
      hub?.invalidate("agent.actions", id);
      hub?.invalidate("agent.coding-requests", id);
    }
  } catch {
    console.error("AgentPier could not report a change of the agent actions.");
  }
}

/**
 * Pipeline run `runId` changed: an action that started it shows its live state, so
 * the action topics of its agents read again. Looked up only while one is watched.
 */
export function agentRunChanged(services, runId) {
  const hub = services.live;
  if (!hub || typeof runId !== "string") return;
  if (!hub.named("agent.actions").length && !hub.named("agent.coding-requests").length)
    return;
  let ids = [];
  try {
    ids = services.assistants?.workflows?.store.agentsOfRun(runId) || [];
  } catch {
    // A closed action store has no agents left to show the run.
  }
  agentActionsChanged(hub, ids);
}

/** Something the channel list shows changed (ChannelService's onChange). */
export function agentChannelsChanged(hub) {
  hub?.invalidate("agent.channels");
  // A reminder's Telegram delivery state is an outbox entry.
  hub?.invalidate("agent.reminders");
}

// The reminder service's writes: an agent's reminders, or (a run's result, `complete`)
// any agent's.
const REMINDER_WRITES = ["create", "update", "remove", "review", "disable", "complete"];

/**
 * Signals `agent.reminders` on `hub()` once each reminder write of `reminders`
 * (NativeReminders) has settled, after its cron job changed in the Gateway too: the
 * agent's topic for a write, every agent's for a run result. A failing hub is logged.
 */
export function followReminderWrites(reminders, hub) {
  const signal = (id) => {
    try {
      hub()?.invalidate("agent.reminders", id);
    } catch {
      console.error("AgentPier could not report a change of the agent reminders.");
    }
  };
  for (const name of REMINDER_WRITES) {
    const write = reminders[name];
    if (typeof write !== "function") continue;
    reminders[name] = function (id, ...rest) {
      const settled = () => signal(name === "complete" ? undefined : id);
      const result = write.call(this, id, ...rest);
      Promise.resolve(result).then(settled, settled);
      return result;
    };
  }
}
