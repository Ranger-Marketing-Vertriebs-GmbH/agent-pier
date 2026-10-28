// The live channel's wiring: the hub with its deny-by-default gate, the topics (added
// by later changes) and the /api/live socket.
import { LiveHub } from "../features/live/live-hub.js";
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
export function createLiveHub(_services, options = {}) {
  return new LiveHub({
    gate: (principal, topicId) => liveGate(principal, topicId),
    onError: (_error, { topic } = {}) =>
      console.error(`AgentPier could not update the live topic ${topic}.`),
    ...options,
  });
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
