// Paths AgentPier owns. A later capability step moves a path out of this list
// together with its safety rule.
export const lockedPaths = [
  "gateway",
  "update",
  "discovery",
  "telemetry",
  "diagnostics",
  "logging",
  "plugins",
  "tools",
  "cron",
  "channels",
  "browser",
  "memory",
  "skills.allowBundled",
  "skills.workshop",
  "agents.defaults.workspace",
  "agents.defaults.skills",
  "agents.defaults.maxConcurrent",
  "agents.defaults.heartbeat",
  "agents.entries",
  "agents.list",
];

export function isLockedPath(target) {
  return lockedPaths.some(
    (locked) =>
      target === "" ||
      target === locked ||
      target.startsWith(`${locked}.`) ||
      locked.startsWith(`${target}.`),
  );
}

// Written on every start, not only into a fresh file.
export function hardenedDefaults() {
  return {
    channels: {},
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    telemetry: { enabled: false },
    update: { checkOnStart: false, auto: { enabled: false } },
    skillsAllowBundled: [],
    heartbeat: { every: "0m" },
  };
}
