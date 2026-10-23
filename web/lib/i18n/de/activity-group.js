export const activityGroupCopy = {
  agentActivity: "Agent-Aktivität",
  calls: (count) => `${count} ${count === 1 ? "Aufruf" : "Aufrufe"}`,
  failed: (count) => `${count} fehlgeschlagen`,
  running: "Läuft",
  done: "Fertig",
  toolCount: (name, count) => `${name} ${count}`,
};
