import {
  createHermesSwitch,
  stageHermesInBackground,
} from "../features/assistants/runtimes/hermes/hermes-provisioning.js";

/**
 * The owner's Hermes Agent switch (ADR 0006): `state()`, `enable()` (records the
 * opt-in and installs the pinned runtime in the background), `disable()`, and
 * `start()` at server start, which installs or stages the pinned runtime when Hermes
 * is enabled and this AgentPier pins one that is not installed yet (also after an
 * AgentPier update). Agents do not run on Hermes yet; runtime-for.js registers it later.
 */
export function createHermesRuntime({ config }) {
  const hermes = createHermesSwitch({ dataDir: config.dataDir });
  hermes.start = () => stageHermesInBackground({ dataDir: config.dataDir });
  return hermes;
}
