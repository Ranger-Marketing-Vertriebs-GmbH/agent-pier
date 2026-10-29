// The live channel's wiring: the hub with its deny-by-default gate, the topics and
// the /api/live socket.
import { LiveHub } from "../features/live/live-hub.js";
import { stateTopic, watchStateWrites } from "../features/sessions/live-state-topic.js";
import { sessionRequestsTopic } from "../features/requests/live-topics.js";
import { sessionModelsTopic } from "../features/models/live-topics.js";
import { inboxTopic } from "../features/inbox/live-topics.js";
import {
  pipelineCountsTopic,
  pipelineQueueTopic,
  pipelineRunTopic,
  pipelineRunsChangedTopic,
  pipelineRunsTopic,
} from "../features/pipelines/live-topics.js";
import { settingsSummaryTopic } from "../features/settings/live-topics.js";
import { connectionProblemsTopic } from "../features/providers/live-topics.js";
import { runtimeUpdatesTopic } from "../features/assistants/live-runtime-topics.js";
import { agentDetailTopics, agentListTopic } from "../features/assistants/live-topics.js";
import {
  operationJob,
  releaseSessionsTopic,
} from "../features/operations/live-topics.js";
import { defineToolJobTopics } from "../features/tools/live-topics.js";
import { defineJobTopic } from "../features/live/job-topics.js";
import { mcpPackageJob } from "../features/mcp-packages/live-topics.js";
import { pluginsJob } from "../features/plugins/live-topics.js";
import { sshToolsJob } from "../features/ssh/live-topics.js";
import { chatgptLoginJob } from "../features/assistants/live-login-topics.js";
import { sessionReloadTopic } from "../features/sessions/live-reload-topic.js";
import { filesJobsTopic } from "../features/files/live-topics.js";
import { sessionDeliveriesTopic } from "../features/chat/live-delivery-topics.js";
import {
  artifactsChangedTopic,
  artifactsUsageTopic,
} from "../features/artifacts/live-topics.js";
import {
  cleanupSummaryTopic,
  systemStatusTopics,
} from "../features/system-status/live-topics.js";
import { meTopics } from "../features/users/live-me-topics.js";
import { attachLiveWebSocket } from "../http/live-websocket.js";
import { userMayWatch, userTopics } from "../http/route-access.js";

/**
 * The owner reaches every topic whose own `authorize` lets him in; a restricted user
 * only those in `userTopics`. Anyone else reaches none.
 */
export const liveGate = (principal, topicId, topics = userTopics) =>
  principal?.role === "owner" ||
  (principal?.role === "user" && userMayWatch(topicId, topics));

/**
 * Logs a topic read that failed. A refusal (a missing project, an invalid id) and a
 * failure the topic marks `expected` (agents not running) are the answer, not a
 * fault: the client reads the route once and shows it, so they are not logged.
 */
export function reportLiveError(error, { topic } = {}) {
  if (error?.expected === true) return;
  if (Number.isInteger(error?.status) && error.status < 500) return;
  console.error(`AgentPier could not update the live topic ${topic}.`);
}

/** The hub with its topics. */
export function createLiveHub(services, options = {}) {
  const hub = new LiveHub({
    gate: (principal, topicId) => liveGate(principal, topicId),
    onError: reportLiveError,
    ...options,
  });
  hub.define(stateTopic(services));
  watchStateWrites(services, hub);
  hub.define(sessionRequestsTopic(services));
  hub.define(sessionModelsTopic(services));
  hub.define(inboxTopic(services));
  hub.define(pipelineRunTopic(services));
  hub.define(pipelineQueueTopic(services));
  hub.define(pipelineCountsTopic(services));
  hub.define(pipelineRunsTopic(services));
  hub.define(pipelineRunsChangedTopic());
  hub.define(settingsSummaryTopic(services));
  hub.define(connectionProblemsTopic(services));
  hub.define(runtimeUpdatesTopic(services));
  hub.define(agentListTopic(services));
  for (const topic of agentDetailTopics(services)) hub.define(topic);
  defineJobTopic(hub, operationJob(services));
  defineToolJobTopics(hub, services);
  defineJobTopic(hub, mcpPackageJob(services));
  defineJobTopic(hub, pluginsJob(services));
  defineJobTopic(hub, sshToolsJob(services));
  defineJobTopic(hub, chatgptLoginJob(services));
  hub.define(sessionReloadTopic(services));
  hub.define(filesJobsTopic(services));
  hub.define(sessionDeliveriesTopic());
  hub.define(releaseSessionsTopic(services));
  hub.define(artifactsUsageTopic(services));
  hub.define(artifactsChangedTopic());
  for (const topic of systemStatusTopics(services)) hub.define(topic);
  hub.define(cleanupSummaryTopic(services));
  // A restricted user's own topics, each scoped to her (route-access.js userTopics).
  for (const topic of meTopics(services)) hub.define(topic);
  // Topics whose value depends on owner privacy start over on every privacy change,
  // before anything else is sent (live-hub.js resetWhere).
  const privacyChanged = () => {
    if (!hub.closed) hub.resetWhere((definition) => definition.privacy === true);
  };
  services.ownerPrivacy?.on("changed", privacyChanged);
  hub.onClose(() => services.ownerPrivacy?.off("changed", privacyChanged));
  return hub;
}

// Topics whose sources announce no change of their own: any successful write may
// have changed them. This middleware is their change source until those stores
// announce their changes themselves. A write without subscribers costs nothing; one that changed
// nothing sends nothing (the digest is equal).
export const WRITE_SIGNALED_TOPICS = Object.freeze([
  "settings.summary",
  "connections.problems",
  "runtime.updates",
]);
// Frequent writes that touch none of them: session input and chat, agent chats, the
// user's own routes, notifications, files, runs and memory.
const QUIET_WRITE_AREAS = new Set([
  "sessions",
  "assistant-conversations",
  "me",
  "notifications",
  "files",
  "file-operations",
  "file-transfers",
  "pipeline-runs",
  "pipeline-queue",
  "memory",
  "artifacts",
  "presence",
]);
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Express middleware for /api: once a write has answered with success, signals
 * WRITE_SIGNALED_TOPICS on `services.live` (read when the answer is sent).
 */
export function liveWriteSignals(services) {
  return (req, res, next) => {
    const area = req.path.split("/")[1];
    if (READS.has(req.method) || QUIET_WRITE_AREAS.has(area)) return next();
    res.once("finish", () => {
      if (res.statusCode >= 400) return;
      for (const topic of WRITE_SIGNALED_TOPICS) services.live?.invalidate(topic);
    });
    next();
  };
}

/**
 * Calls `listener` on owner-privacy changes and on every event of the current agent
 * services. Agents switched on or off later replace those services, so each switch
 * binds again to the new events and reports a change once.
 */
export function agentAndPrivacyChanges(services, listener) {
  let offAgents = null;
  const bind = () => {
    offAgents?.();
    offAgents = services.assistants?.events?.subscribe(listener) || null;
  };
  const rebind = () => {
    bind();
    listener();
  };
  const feature = services.assistantFeature?.events;
  bind();
  feature?.on("started", rebind);
  feature?.on("stopped", rebind);
  services.ownerPrivacy?.on("changed", listener);
  return () => {
    offAgents?.();
    offAgents = null;
    feature?.off("started", rebind);
    feature?.off("stopped", rebind);
    services.ownerPrivacy?.off("changed", listener);
  };
}

/**
 * Creates the hub, attaches /api/live to `server` and stores both on `services`
 * (`live`, `liveWss`). Owner-privacy and agent changes check every subscription again.
 */
export function attachLive(server, services, { admit, effective }) {
  const hub = createLiveHub(services);
  services.live = hub;
  services.liveWss = attachLiveWebSocket(server, {
    hub,
    login: services.identity,
    admit,
    effective,
    changes: (listener) => agentAndPrivacyChanges(services, listener),
    presence: (route, scope) => services.notifications?.reportPresence(route, scope),
  });
  return hub;
}
