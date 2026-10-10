// Operator overrides from config.json `pipelines`; invalid values keep the defaults.
const settings = {
  completionGraceSeconds: ["completionGraceMs", 1000, 5, 3600],
  inactivityTimeoutMinutes: ["inactivityTimeoutMs", 60000, 1, 1440],
  // Wall-clock bound of one native turn; 0 disables it, inactivity still applies.
  turnTimeoutMinutes: ["turnTimeoutMs", 60000, 0, 10080],
};
// Keys accepted from earlier builds, read only when the current key is absent.
const legacy = { stageTimeoutMinutes: "turnTimeoutMinutes" };
export function pipelineTiming(saved) {
  const timing = {};
  if (saved && typeof saved === "object")
    for (const [old, current] of Object.entries(legacy))
      if (saved[current] === undefined && saved[old] !== undefined)
        saved = { ...saved, [current]: saved[old] };
  for (const [name, [key, unit, min, max]] of Object.entries(settings)) {
    const value = saved?.[name];
    if (Number.isInteger(value) && value >= min && value <= max)
      timing[key] = value * unit;
  }
  return timing;
}
