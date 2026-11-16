import { hermesAdvancedSettings } from "./hermes-config/advanced.js";

/**
 * How Hermes agents take the advanced settings (runtime-for.js `advancedRuntimes`,
 * advanced-config.js): the shared settings Hermes has an equivalent of
 * (hermes-config/advanced.js), compiled into each agent's home at its start and
 * apply. A save of one applies every Hermes agent; each restarts only if its home or
 * its time zone changed (the thinking level applies at the next turn). An
 * installation the mapping is not approved for starts with Hermes's own defaults and
 * the values stay stored, so nothing is refused here.
 *
 * `fleet()` is the Hermes fleet (its selected installation), `available()` whether
 * Hermes may run now (the owner's switch and an installation).
 */
export const hermesAdvanced = ({ fleet, available }) =>
  Object.freeze({
    settings: () => hermesAdvancedSettings,
    status() {
      const version = fleet().installedVersion();
      return {
        enabled: available(),
        // One process set per agent: no single host runs or stops.
        running: null,
        settled: true,
        version,
        qualified: !version || version === hermesAdvancedSettings.runtime,
      };
    },
    // Hermes agents compile the stored value at their apply.
    stored: (_setting, { applyAgents }) => applyAgents(),
  });
