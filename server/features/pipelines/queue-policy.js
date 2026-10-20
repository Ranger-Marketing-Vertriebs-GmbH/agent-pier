import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// A project's run queue starts its next item while fewer of the project's runs are
// active than its limit. These rules are pure, so scheduling can be tested without
// an engine.
export const MAX_QUEUE_CONCURRENCY = 20;
export const defaultQueueSettings = () => ({ limit: 1, countParked: false });

/** The owner's queue settings of a project: concurrent runs and whether parked runs count. */
export function validateQueueSettings(body) {
  if (
    !body ||
    typeof body !== "object" ||
    !Number.isSafeInteger(body.limit) ||
    body.limit < 1 ||
    body.limit > MAX_QUEUE_CONCURRENCY ||
    typeof body.countParked !== "boolean"
  )
    throw problem(serverMessages.pipelineQueue.invalidSettings);
  return { limit: body.limit, countParked: body.countParked };
}

/** Stored settings; restored or hand-edited values outside the range use the defaults. */
export function storedQueueSettings(value) {
  try {
    return validateQueueSettings(value);
  } catch {
    return defaultQueueSettings();
  }
}

/**
 * Whether an active run takes one of its project's slots. A running run always does.
 * A run waiting for the owner (a gate, a risk or budget stop, a failed stage) counts
 * only when the project says so; a run that waits for a provider's usage reset resumes
 * on its own and keeps its slot.
 */
export function holdsSlot(run, { countParked }) {
  if (run.status === "running") return true;
  if (run.status !== "awaiting-human") return false;
  return countParked || Boolean(run.usageResumeAt);
}

/**
 * The slots a project's active runs take: every active run of the project, whether
 * started by the queue or not, plus queue items that are being started and have no
 * run yet. `runs` are the engine's running and waiting runs.
 */
export function occupiedSlots({ projectId, items, runs, settings }) {
  const queued = new Set(
    items
      .filter((item) => item.state === "starting" || item.state === "started")
      .map((item) => item.id),
  );
  const seen = new Set();
  let count = 0;
  for (const run of runs) {
    if (
      run.projectId !== projectId &&
      run.expectedProjectId !== projectId &&
      !queued.has(run.id)
    )
      continue;
    seen.add(run.id);
    if (holdsSlot(run, settings)) count++;
  }
  for (const item of items) if (item.state === "starting" && !seen.has(item.id)) count++;
  return count;
}

/** The items to start now, in queue order. */
export function itemsToStart({ projectId, items, runs, settings }) {
  const free = settings.limit - occupiedSlots({ projectId, items, runs, settings });
  if (free <= 0) return [];
  return items
    .filter((item) => item.state === "queued")
    .sort((a, b) => a.position - b.position)
    .slice(0, free);
}
