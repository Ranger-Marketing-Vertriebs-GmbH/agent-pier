import { activityGroupCopy as copy } from "../lib/i18n/messages/activity-group.js";

/**
 * The head of an activity group (ActivityGroup.jsx): "N calls" with an optional
 * `summary` (a host, or the main tools), and a chip that keeps failures visible while
 * the group is shut: "Running" while a call runs, "N failed", or "Done" once every
 * call is known to have ended well (`done`); no chip otherwise.
 */
export function activityGroupHead({ count, summary, failed = 0, running = false, done }) {
  const status = [running && copy.running, failed > 0 && copy.failed(failed)].filter(
    Boolean,
  );
  return {
    detail: [copy.calls(count), summary].filter(Boolean).join(" · "),
    status: status.length ? status.join(" · ") : done ? copy.done : null,
    tone: failed > 0 ? "error" : running ? "running" : "ok",
  };
}

/** The `limit` most used names as "Bash 5 · Edit 2 · Read 3" (ties: first seen). */
export function toolSummary(names, limit = 3) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => copy.toolCount(name, count))
    .join(" · ");
}
