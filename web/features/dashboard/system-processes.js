// System status › Processes: the rows of /system-status/details in two groups
// (tests/unit/system-processes.test.js).

export const PROCESS_SORTS = ["cpu", "memory", "name"];

const round = (value) => Math.round(value * 10) / 10;
const sum = (rows, key) => rows.reduce((total, item) => total + (item[key] || 0), 0);

/**
 * The AgentPier core (server, agent gateway) and the sessions, each sorted by `sort`
 * (`cpu` and `memory` from the largest, `name` alphabetically) and summed. `largest`
 * scales the inline bars over the rows of both groups.
 */
export function processGroups(processes, sort, name) {
  const byName = (a, b) =>
    name(a).localeCompare(name(b), undefined, { sensitivity: "base" });
  const by = {
    cpu: (a, b) => b.cpuPercent - a.cpuPercent || byName(a, b),
    memory: (a, b) => b.rssBytes - a.rssBytes || byName(a, b),
    name: byName,
  }[sort];
  const group = (rows) => ({
    rows: [...rows].sort(by),
    cpuPercent: round(sum(rows, "cpuPercent")),
    rssBytes: sum(rows, "rssBytes"),
    processes: sum(rows, "processes"),
  });
  return {
    core: group(processes.filter((item) => item.kind !== "session")),
    sessions: group(processes.filter((item) => item.kind === "session")),
    largest: {
      cpuPercent: Math.max(0, ...processes.map((item) => item.cpuPercent || 0)),
      rssBytes: Math.max(0, ...processes.map((item) => item.rssBytes || 0)),
    },
  };
}

/**
 * The agents the gateway runs, counted like Agents › All agents (no archived agent, no
 * temporary team member); null until the agents are loaded or while they are off.
 */
export function gatewayAgentCount(agents) {
  if (!agents?.loaded || !Array.isArray(agents.assistants)) return null;
  return agents.assistants.filter(
    (a) => !a.archivedAt && (!a.teamMemberId || a.lifetime === "permanent"),
  ).length;
}
