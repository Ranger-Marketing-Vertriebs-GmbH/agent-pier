// The live channel's wiring: the hub with its deny-by-default gate, the topics and
// the /api/live socket.
import { LiveHub } from "../features/live/live-hub.js";
import { stateTopic, watchStateWrites } from "../features/sessions/live-state-topic.js";
import { sessionRequestsTopic } from "../features/requests/live-topics.js";
import { sessionModelsTopic } from "../features/models/live-topics.js";
import { inboxTopic } from "../features/inbox/live-topics.js";
import {
  pipelineQueueTopic,
  pipelineRunTopic,
} from "../features/pipelines/live-topics.js";
import { attachLiveWebSocket } from "../http/live-websocket.js";
import { userMayWatch, userTopics } from "../http/route-access.js";

/**
 * The owner reaches every topic whose own `authorize` lets him in; a restricted user
 * only those in `userTopics`. Anyone else reaches none.
 */
export const liveGate = (principal, topicId, topics = userTopics) =>
  principal?.role === "owner" ||
  (principal?.role === "user" && userMayWatch(topicId, topics));

/** The hub with its topics. */
export function createLiveHub(services, options = {}) {
  const hub = new LiveHub({
    gate: (principal, topicId) => liveGate(principal, topicId),
    onError: (_error, { topic } = {}) =>
      console.error(`AgentPier could not update the live topic ${topic}.`),
    ...options,
  });
  hub.define(stateTopic(services));
  watchStateWrites(services, hub);
  hub.define(sessionRequestsTopic(services));
  hub.define(sessionModelsTopic(services));
  hub.define(inboxTopic(services));
  hub.define(pipelineRunTopic(services));
  hub.define(pipelineQueueTopic(services));
  return hub;
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
  });
  return hub;
}
