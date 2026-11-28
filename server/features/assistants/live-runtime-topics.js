import { runtimeList } from "./runtimes/runtime-for.js";

// The live `runtime.updates` topic: the agent runtime's update status, the value
// GET /api/assistant-runtime/updates answers. That status is local (the update
// journal and the staged candidate); no remote check runs. Update actions and the
// owner's other successful writes signal it (live-wiring.js liveWriteSignals), agents
// switched on or off too, and a staging or recovery in progress is sampled every
// 60 s while a visible tab watches. Owner only.
export const RUNTIME_UPDATES_SAMPLE_MS = 60000;

// Without agent services the route answers 404 (agents off) or 503 (on but not
// running). The topic refuses with the same status, marked `expected`: the hub does
// not log it (live-wiring.js), so a sample per minute writes no log line, and the
// client reads the route once to show its answer.
export const notRunning = (enabled) =>
  Object.assign(new Error("The agent services are not running."), {
    status: enabled ? 503 : 404,
    expected: true,
  });

/** The topic definition for LiveHub#define. */
export function runtimeUpdatesTopic(services) {
  return {
    name: "runtime.updates",
    mode: "state",
    sampleMs: RUNTIME_UPDATES_SAMPLE_MS,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read() {
      if (!services.assistants || !services.assistantUpdates)
        throw notRunning(Boolean(services.assistantFeature?.enabled));
      return services.assistantUpdates.status();
    },
    watch: ({ invalidate }) => followAgentSwitch(services, invalidate),
  };
}

// The live `runtimes` topic: every runtime a new agent may run on with its traits,
// its install state and whether it is ready, the value GET /api/assistant-runtimes
// answers (ADR 0007). An optional runtime's switch announces every change of its
// install state (runtimesChanged; application/services.js wires Hermes's), the
// owner's other successful writes signal it too (live-wiring.js liveWriteSignals: an
// agent created or deleted changes the count a state names), and so do agents
// switched on or off. While an install or update runs, its state is also sampled
// every 3 s while a visible tab watches: nothing announces its progress. Owner only.
export const RUNTIMES_SAMPLE_MS = 3000;

/** The body of GET /api/assistant-runtimes: `{ runtimes }` (runtime-for.js runtimeList). */
export const runtimesView = (services) => ({
  runtimes: runtimeList(services.assistantRuntime, services.runtimeInstalls),
});

const busy = (view) =>
  view.runtimes.some(
    ({ install }) => install.installing === true || install.updating === true,
  );

/** The topic definition for LiveHub#define. */
export function runtimesTopic(services) {
  // Whether the last read of a watched topic showed an install or update under way.
  let running = false;
  let watched = false;
  return {
    name: "runtimes",
    mode: "state",
    sampleMs: RUNTIMES_SAMPLE_MS,
    sampling: () => running,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read() {
      if (!services.assistants) {
        running = false;
        throw notRunning(Boolean(services.assistantFeature?.enabled));
      }
      const view = runtimesView(services);
      running = watched && busy(view);
      return view;
    },
    watch({ invalidate }) {
      watched = true;
      const stop = followAgentSwitch(services, invalidate);
      return () => {
        watched = running = false;
        stop?.();
      };
    },
  };
}

// The live `runtime.semantic-memory` topic: the owner's semantic memory search, the
// value GET /api/assistant-semantic-memory answers (off, downloading with its bytes,
// rebuilding with its agents, on, or failed with its reason). The service signals
// every change itself (runtimes/openclaw/semantic-memory.js `changed`: each step of
// a download and of an index rebuild, and a search that answered without
// embeddings), so nothing is sampled. A first watcher has the service check once per
// Gateway process whether embeddings answer (`opened`). Owner only.
export function semanticMemoryTopic(services) {
  return {
    name: "runtime.semantic-memory",
    mode: "state",
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read() {
      if (!services.assistants || !services.assistantSemanticMemory)
        throw notRunning(Boolean(services.assistantFeature?.enabled));
      return services.assistantSemanticMemory.status();
    },
    watch({ invalidate }) {
      // The owner looks at it: asked once per Gateway process whether embeddings
      // answer, in the background; its result is a change like any other.
      services.assistantSemanticMemory?.opened?.();
      return followAgentSwitch(services, invalidate);
    },
  };
}

/** An install state changed: the topic is read again (`live`: the hub, once listening). */
export const runtimesChanged = (live) => live?.invalidate("runtimes");

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
