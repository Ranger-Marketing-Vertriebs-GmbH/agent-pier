export const activityGroupCopy = {
  agentActivity: "Agent-Aktivität",
  calls: (count) => `${count} ${count === 1 ? "Aufruf" : "Aufrufe"}`,
  failed: (count) => `${count} fehlgeschlagen`,
  stopped: (count) => `${count} gestoppt`,
  running: "Läuft",
  done: "Fertig",
  toolCount: (name, count) => `${name} ${count}`,
};
