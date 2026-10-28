// The live channel's wiring: the hub with its deny-by-default gate, the topics (added
// by later changes) and the /api/live socket.
import { LiveHub } from "../features/live/live-hub.js";
import { attachLiveWebSocket } from "../http/live-websocket.js";
import { userMayWatch } from "../http/route-access.js";

/**
 * The owner reaches every topic whose own `authorize` lets him in; a restricted user
 * only those in `userTopics`. Anyone else reaches none.
 */
export const liveGate = (principal, topicId) =>
  principal?.role === "owner" || (principal?.role === "user" && userMayWatch(topicId));

/** The hub with its topics. */
export function createLiveHub(_services, options = {}) {
  return new LiveHub({
    gate: liveGate,
    onError: (_error, { topic } = {}) =>
      console.error(`AgentPier could not update the live topic ${topic}.`),
    ...options,
  });
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
    changes: (listener) => {
      const off = services.assistants?.events?.subscribe(listener);
      services.ownerPrivacy?.on("changed", listener);
      return () => {
        off?.();
        services.ownerPrivacy?.off("changed", listener);
      };
    },
  });
  return hub;
}
