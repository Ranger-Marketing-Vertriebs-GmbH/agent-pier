// The live `runtime.updates` topic: the agent runtime's update status, the value
// GET /api/assistant-runtime/updates answers. That status is local (the update
// journal and the staged candidate); no remote check runs. Update actions and the
// owner's other successful writes signal it (live-wiring.js liveWriteSignals), agents
// switched on or off too, and a staging or recovery in progress is sampled every
// 60 s while a visible tab watches. Owner only.
export const RUNTIME_UPDATES_SAMPLE_MS = 60000;

// Without agent services the route answers 404 (off) or 503 (unavailable). The
// topic refuses with a status below 500, which the hub does not log, and the client
// reads the route once to show its answer: no log line per sample.
const notRunning = () =>
  Object.assign(new Error("The agent services are not running."), { status: 404 });

/** The topic definition for LiveHub#define. */
export function runtimeUpdatesTopic(services) {
  return {
    name: "runtime.updates",
    mode: "state",
    sampleMs: RUNTIME_UPDATES_SAMPLE_MS,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read() {
      if (!services.assistants || !services.assistantUpdates) throw notRunning();
      return services.assistantUpdates.status();
    },
    watch: ({ invalidate }) => followAgentSwitch(services, invalidate),
  };
}

/**
 * Calls `listener` when agents are switched on or off (services.assistantFeature);
 * returns the stop function.
 */
export function followAgentSwitch(services, listener) {
  const events = services.assistantFeature?.events;
  if (!events) return undefined;
  const changed = () => listener();
  events.on("started", changed);
  events.on("stopped", changed);
  return () => {
    events.off("started", changed);
    events.off("stopped", changed);
  };
}
