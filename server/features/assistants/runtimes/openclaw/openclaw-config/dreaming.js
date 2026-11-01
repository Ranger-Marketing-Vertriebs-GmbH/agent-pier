import { isDeepStrictEqual } from "node:util";

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

const dreamingPath = "plugins.entries.memory-core.config.dreaming";
/**
 * The live `config.patch` that gives the running configuration `config` the
 * dreaming section of `wanted` (the owner's setting), or null when it holds it.
 */
export function dreamingPatch(config, wanted) {
  const section = dreamingSection(wanted);
  return isDeepStrictEqual(
    config.plugins?.entries?.["memory-core"]?.config?.dreaming,
    section,
  )
    ? null
    : {
        patch: {
          plugins: { entries: { "memory-core": { config: { dreaming: section } } } },
        },
        replacePaths: [dreamingPath],
      };
}
