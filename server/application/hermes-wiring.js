import {
  createHermesSwitch,
  stageHermesInBackground,
} from "../features/assistants/runtimes/hermes/hermes-provisioning.js";
import {
  createHermesUpdates,
  hermesLifecycle,
} from "../features/assistants/runtimes/hermes/hermes-lifecycle.js";
import { HermesFleet } from "../features/assistants/runtimes/hermes/hermes-fleet.js";
import { hermesRunnable } from "../features/assistants/runtimes/hermes/hermes-provisioning.js";
import {
  attachHermesFleet,
  hermesFleetOf,
  runtimeIdOf,
} from "../features/assistants/runtimes/runtime-for.js";

/** The agents OpenClaw runs: every agent that does not run on its own Hermes set. */
export const openClawProfiles = (profiles) =>
  profiles.filter((profile) => runtimeIdOf(profile) === "openclaw");

/**
 * The Hermes fleet of an assistant graph (ADR 0006 decision 4): one process set per
 * Hermes agent, resolved through the OpenClaw `supervisor` every caller passes
 * (runtime-for.js). Sets run while Hermes is enabled and installed; an agent on
 * "Every command" (`shell: "approval"`, `shellEveryCommand`) asks before each command.
 */
export function hermesAgentFleet(supervisor, { dataDir, store }) {
  return attachHermesFleet(
    supervisor,
    new HermesFleet({
      dataDir,
      available: () => hermesRunnable(dataDir),
      strict: (agentId) => {
        const profile = store.listAssistants().find((p) => p.runtimeAgentId === agentId);
        return profile?.shell === "approval" && profile.shellEveryCommand === true;
      },
    }),
  );
}

const stableCode = (error, fallback) =>
  /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : fallback;

// The Hermes fleet of the running agent services, or null while they are off.
const fleetOf = (services) =>
  services.assistants?.runtime ? hermesFleetOf(services.assistants.runtime) : null;
const hermesAgents = (services) =>
  (services.assistants?.store.listAssistants() || []).filter(
    (a) => a.runtime === "hermes",
  );

/**
 * The host the update journal (runtime-updates.js) drives for Hermes: every Hermes
 * agent's process set at once. Stop ends them all, start starts those not archived,
 * and the lifecycle methods are Hermes's (hermes-lifecycle.js).
 */
export function hermesUpdateHost(services) {
  const sets = () => fleetOf(services)?.list() || [];
  const status = () => ({
    availability: sets().some(
      ({ runtime }) => runtime.host.status().availability !== "disabled",
    )
      ? "ready"
      : "disabled",
    sync: null,
    version: null,
    diagnostic: null,
  });
  const fleet = {
    status,
    generationId: null,
    async assertStopped() {
      for (const { runtime } of sets()) await runtime.host.assertStopped();
    },
  };
  return {
    ...hermesLifecycle(fleet),
    status,
    start: async () => {
      await fleetOf(services)?.startAll(hermesAgents(services));
    },
    stop: async () => {
      await fleetOf(services)?.stopAll();
    },
  };
}

// No AgentPier maintenance is needed to swap Hermes: only Hermes agents stop, and a
// failed start rolls the installation and their homes back to the snapshot.
export const hermesUpdateMaintenance = (services) => ({
  enter: async () => {},
  leave: async () => {},
  quiesce: async () => {},
  blockers: async () => [],
  async validate() {
    for (const { runtime } of fleetOf(services)?.list() || [])
      if (runtime.host.status().availability === "failed")
        throw Object.assign(Error("HERMES_UPDATE_VALIDATION_FAILED"), {
          code: "HERMES_UPDATE_VALIDATION_FAILED",
        });
  },
});

/**
 * The owner's Hermes Agent switch (ADR 0006): `state()`, `enable()` (records the
 * opt-in and installs the pinned runtime in the background; the Hermes agents start
 * once it is installed), `disable()` (their process sets stop), `update()` (installs
 * the pinned version beside the selected one and activates it through the update
 * journal, restarting the Hermes agents; a failed start rolls back), and `start()` at
 * server start, which installs or stages the pinned runtime when Hermes is enabled
 * and this AgentPier pins one that is not installed yet (also after an AgentPier
 * update). `services` is the application's, read lazily: agent services exist only
 * while agents are on.
 */
export function createHermesRuntime({ config, services = {} }) {
  const { dataDir } = config;
  const hermes = createHermesSwitch({ dataDir });
  const base = hermes.state;
  let updating = null;
  let updateError = null;
  hermes.state = () => {
    const state = base();
    return {
      ...state,
      error: state.error || updateError,
      updating: !!updating,
      // A newer pin, or the same release with an extra it lacks (hermes-install.js).
      updateAvailable: state.installed && !state.current,
      agents: hermesAgents(services).length,
    };
  };
  const enable = hermes.enable;
  // Once the background installation settled, the Hermes agents start.
  hermes.enable = async () => {
    await enable();
    hermes
      .settled()
      .then(() => {
        const now = hermes.state();
        if (now.enabled && now.installed)
          return fleetOf(services)?.startAll(hermesAgents(services));
      })
      .catch(() => {});
    return hermes.state();
  };
  const disable = hermes.disable;
  hermes.disable = async () => {
    await disable();
    await fleetOf(services)?.stopAll();
    return hermes.state();
  };
  hermes.update = async () => {
    const state = hermes.state();
    if (updating || !state.enabled || !state.installed) return state;
    updateError = null;
    updating = (async () => {
      const updates = createHermesUpdates({
        dataDir,
        host: hermesUpdateHost(services),
        maintenance: hermesUpdateMaintenance(services),
      });
      await updates.stage();
      if (updates.status().candidateReady) await updates.activate();
    })()
      .catch((error) => {
        updateError = stableCode(error, "HERMES_UPDATE_FAILED");
      })
      .finally(() => {
        updating = null;
        hermes.onChange?.();
      });
    return hermes.state();
  };
  hermes.updating = () => updating || Promise.resolve();
  hermes.start = () => stageHermesInBackground({ dataDir });
  return hermes;
}
