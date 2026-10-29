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

/**
 * The topic `system.cleanup.summary`: what GET /api/system-status/cleanup/summary
 * answers (the cached background measurement of what the Storage tab can free). It is
 * not sampled: StorageCleanup signals when a measurement starts over (a deletion),
 * ends or fails, so the dialog sees "measuring" turn into "measured". A failed
 * measurement is retried once its retry delay has passed, while someone still
 * watches (the dialog's former poll did so). Owner only.
 */
export function cleanupSummaryTopic(
  services,
  { timers = { setTimeout, clearTimeout } } = {},
) {
  let invalidate = null;
  let retry = null;
  const cancel = () => {
    timers.clearTimeout(retry);
    retry = null;
  };
  return {
    name: "system.cleanup.summary",
    mode: "state",
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: () => {
      const { storageCleanup } = services;
      const value = storageCleanup.summary();
      if (value?.state === "failed" && invalidate && !retry) {
        retry = timers.setTimeout(() => {
          retry = null;
          invalidate?.();
        }, storageCleanup.summaryMeasure?.retryMs ?? 60000);
        retry?.unref?.();
      }
      return value;
    },
    watch: (context) => {
      invalidate = context.invalidate;
      const events = services.storageCleanup.events;
      const changed = () => context.invalidate();
      events.on("change", changed);
      return () => {
        invalidate = null;
        cancel();
        events.off("change", changed);
      };
    },
  };
}
