export const activityGroupCopy = {
  agentActivity: "Agent activity",
  calls: (count) => `${count} ${count === 1 ? "call" : "calls"}`,
  failed: (count) => `${count} failed`,
  stopped: (count) => `${count} stopped`,
  running: "Running",
  done: "Done",
  toolCount: (name, count) => `${name} ${count}`,
};
