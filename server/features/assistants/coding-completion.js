import { permanentReasons } from "./native-routines.js";

const maxEventRetryMs = 300000;

/**
 * Emits coding.completed for a completed coding request of the agent itself
 * (AssistantWorkflows.advanceAction). Returns whether the terminal action has no
 * follow-up work left; a failed emit retries with backoff.
 */
export async function emitCompletion(w, a) {
  if (
    a.payload.action !== "coding_start" ||
    a.state !== "completed" ||
    // A member's run is reported to the member and the team, not to the
    // parent's own coding.completed routines.
    a.requestedBy ||
    !w.s.assistantRoutines ||
    a.eventEmitted ||
    a.eventSkipped
  )
    return true;
  if (a.eventRetryAt > w.now()) return false;
  try {
    const results = await w.s.assistantRoutines.emit({
      assistantId: a.assistantId,
      kind: "coding.completed",
      eventId: `coding:${a.id}:completed`,
    });
    const skipped = results.filter((r) => r.status === "skipped");
    w.store.patch(a.id, {
      eventEmitted: true,
      eventRetryAt: undefined,
      ...(skipped.length ? { eventSkippedBindings: skipped } : {}),
    });
    return true;
  } catch (error) {
    const reason = permanentReasons[error.status];
    if (reason) {
      w.store.patch(a.id, {
        eventSkipped: { status: error.status, reason },
        eventRetryAt: undefined,
      });
      return true;
    }
    const failures = (a.eventFailures || 0) + 1;
    w.store.patch(a.id, {
      eventFailures: failures,
      eventRetryAt: w.now() + Math.min(1000 * 2 ** failures, maxEventRetryMs),
    });
    return false;
  }
}
