// The live `system.status` and `system.status.details` topics: the values
// GET /api/system-status and GET /api/system-status/details answer. The load of the
// computer has no change signal, so the hub reads each every 5 s while a visible tab
// watches (hidden tabs unsubscribe), which also keeps the sampler of SystemStatus
// running as a page view does. Every sample differs, so each read is a push. Owner
// only; the figures carry no secrets (session ids, never names).
export const SYSTEM_STATUS_SAMPLE_MS = 5000;

const topic = (name, read) => ({
  name,
  mode: "state",
  sampleMs: SYSTEM_STATUS_SAMPLE_MS,
  authorize: (principal) => principal?.role === "owner",
  scopeKey: () => "owner",
  read,
});

/** The topic definitions for LiveHub#define. */
export function systemStatusTopics(services) {
  return [
    topic("system.status", () => services.systemStatus.summary()),
    topic("system.status.details", () => services.systemStatus.details()),
  ];
}
