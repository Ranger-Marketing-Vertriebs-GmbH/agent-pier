/**
 * memory-core's `dreaming` config for the owner's setting. On, the nightly sweep runs
 * at `hour` in `timeZone` for every agent in the runtime, with every phase at
 * memory-core's defaults (deep included). No `model` key: dreaming uses each agent's
 * own model.
 */
export function dreamingSection({ enabled, hour, timeZone } = {}) {
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    frequency: `0 ${hour} * * *`,
    timezone: timeZone,
    storage: { mode: "separate" },
  };
}
