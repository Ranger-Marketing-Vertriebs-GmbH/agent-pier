/** Above this many entries the Completed group of the sheet starts collapsed. */
export const COMPLETED_OPEN_LIMIT = 5;

/** End states worth listing from saved data. */
const ENDED = ["completed", "failed", "stopped"];

const updated = (agent) => {
  const time = Date.parse(agent?.updatedAt);
  return Number.isFinite(time) ? time : null;
};
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * Subagents for the background tasks sheet. Saved or stale data (`live` false)
 * never shows a working agent, and an unresolved state is only worth showing
 * while live. Finished agents stay listed, newest completion first; agents
 * without a time come last and equal times keep the observed order.
 */
export function groupSubagents(subagents, live = false) {
  const running = [],
    finished = [];
  for (const [order, agent] of list(subagents).entries()) {
    if (agent?.status === "running") {
      if (live) running.push(agent);
      continue;
    }
    if (!live && !ENDED.includes(agent?.status)) continue;
    finished.push({ agent, order, time: updated(agent) });
  }
  finished.sort((a, b) => {
    if (a.time === b.time) return a.order - b.order;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return b.time - a.time;
  });
  return { running, finished: finished.map(({ agent }) => agent) };
}

/**
 * Subagents and shells of the sheet, each entry marked with its `kind`, grouped by
 * the rules of `groupSubagents` (a stopped task counts as finished).
 */
export const groupTasks = ({ subagents, shells } = {}, live = false) =>
  groupSubagents(
    [
      ...list(subagents).map((entry) => ({ ...entry, kind: "agent" })),
      ...list(shells).map((entry) => ({ ...entry, kind: "shell" })),
    ],
    live,
  );

/**
 * What the line above the composer says, or null when there is nothing to say:
 * working agents first, then unfinished to-dos, then finished work to look up.
 */
export function tasksLine({ running = [], finished = [], tasks = [] }) {
  if (running.length) return { kind: "running", count: running.length };
  const done = tasks.filter((task) => task.status === "completed").length;
  if (tasks.length && done < tasks.length)
    return { kind: "todos", done, total: tasks.length };
  if (finished.length || tasks.length) return { kind: "history" };
  return null;
}

export const completedStartsOpen = (finished) => finished.length <= COMPLETED_OPEN_LIMIT;
