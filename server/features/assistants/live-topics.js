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
