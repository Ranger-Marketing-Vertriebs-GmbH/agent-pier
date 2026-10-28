// The live `me.*` topics: what a restricted user's app follows instead of her former
// event stream. Each topic's value is exactly what its /api/me route answers her
// (route-access.js lists each topic next to that route):
// - `me.agents`: GET /api/me/agents, her agents with her main chat and its activity;
// - `me.account`: GET /api/me, her account and whether the owner reads her chats;
// - `me.approvals`: GET /api/me/approvals, the approvals waiting for her;
// - `me.chats:<agentId>`: GET /api/me/agents/:id/chats, her open chats with the agent;
// - `me.telegram:<agentId>`: GET /api/me/agents/:id/telegram, her own bot;
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
import { userProblem } from "./user-errors.js";
import { AGENT_PARAM } from "../assistants/live-topics.js";
import { followAgentSwitch, notRunning } from "../assistants/live-runtime-topics.js";

// Her reminders' cron jobs live in the Gateway, like the owner's (agent.reminders).
export const ME_REMINDERS_SAMPLE_MS = 30000;

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

/** Whether agent `agentId` serves the restricted user `principal`. */
const serves = (services, principal, agentId) =>
  user(principal) &&
  (services.userScope?.agentsFor(principal.userId) || []).some((a) => a.id === agentId);

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
 * binding to the services that are current then. Returns the stop function.
 */
export function followAgentEvents(services, listener) {
  let unbind = null;
  const bind = () => {
    unbind?.();
    unbind = services.assistants?.events?.subscribe(() => listener()) || null;
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

function meTopic(services, { name, param = false, read, watch, sampleMs }) {
  return {
    name,
    mode: "state",
    ...(param && { param: AGENT_PARAM }),
    ...(sampleMs && { sampleMs }),
    authorize: (principal, agentId) =>
      param ? serves(services, principal, agentId) : user(principal),
    scopeKey: (principal) => `user:${principal.userId}`,
    async read(principal, agentId) {
      // Checked again per read: a read never answers for an agent she lost.
      if (param && !serves(services, principal, agentId)) {
        running(services);
        throw expected(services.userScope.refusal());
      }
      try {
        return await read(principal, agentId);
      } catch (error) {
        throw expected(error);
      }
    },
    watch: ({ invalidate }) =>
      (watch || ((listener) => followAgentEvents(services, listener)))(() =>
        invalidate(),
      ),
  };
}

/** The `me.*` topic definitions for LiveHub#define. */
export function meTopics(services) {
  return [
    meTopic(services, {
      name: "me.agents",
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
      watch: (listener) => {
        const privacy = services.ownerPrivacy;
        privacy?.on("changed", listener);
        return () => privacy?.off("changed", listener);
      },
    }),
    meTopic(services, {
      name: "me.approvals",
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
      read: (principal, agentId) =>
        running(services).chats.list(agentId, { userId: principal.userId }),
    }),
    meTopic(services, {
      name: "me.telegram",
      param: true,
      read: (principal, agentId) => {
        const assistants = running(services);
        const agent = services.userScope.agentOf(principal, agentId);
        if (!canPairTelegram(agent, principal.userId)) throw userProblem("USER_LEVEL");
        return {
          channel: telegramView(
            userChannel(
              assistants,
              services.assistantChannels,
              agent.id,
              principal.userId,
            ),
          ),
        };
      },
    }),
    meTopic(services, {
      name: "me.reminders",
      param: true,
      sampleMs: ME_REMINDERS_SAMPLE_MS,
      read: (principal, agentId) => {
        running(services);
        return services.assistantReminders.list(agentId, { userId: principal.userId });
      },
    }),
  ];
}
