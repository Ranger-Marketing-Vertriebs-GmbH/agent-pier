import { RuntimeUpdates } from "../../runtime-updates.js";
import { hermesManifest } from "./hermes-manifest.js";
import { hermesPaths } from "./hermes-paths.js";
import {
  sameHermesRuntime,
  shippedHermesRuntime,
  stageHermesRuntime,
} from "./hermes-install.js";
import { stageHermesInBackground } from "./hermes-provisioning.js";

/**
 * The install, update, rollback and restart-reason methods of the Hermes host
 * sub-port (../agent-runtime.js) over `supervisor` (hermes-supervisor.js, or any
 * object with `assertStopped`, `status` and `generationId`). AgentPier's update
 * journal decides when; these do what is particular to Hermes: the pinned commit,
 * uv and CPython (hermes-manifest.js, hermes-install.js). Hermes has no downgrade
 * path and migrates its own `config.yaml` (`_config_version`) when it starts, so an
 * update migrates nothing here and a rollback is the snapshot the journal restores.
 */
export function hermesLifecycle(supervisor = {}) {
  return {
    install: (options) => stageHermesRuntime(options),
    sameInstall: (a, b) => sameHermesRuntime(a, b),
    // `nodeVersion` keeps the journal's status shape; Hermes runs on CPython.
    target: () => ({
      version: hermesManifest.version,
      nodeVersion: null,
      pythonVersion: hermesManifest.pythonVersion,
    }),
    current: (record) => shippedHermesRuntime(record),
    stageUpdate: (options) => stageHermesInBackground(options),
    migrate: async () => {},
    stopMigration: async () => {},
    clearMigration: () => {},
    assertStopped: async () => supervisor.assertStopped?.(),
    generation: () => supervisor.generationId ?? null,
    // Hermes reads config.yaml at each start: a running process set needs a restart
    // for a change it cannot load.
    restartNeeded() {
      const availability = supervisor.status?.().availability;
      return !!availability && availability !== "disabled";
    },
  };
}

/**
 * AgentPier's update journal (runtime-updates.js) for Hermes: its own selection,
 * candidate, journal and snapshot under `<data>/assistants/hermes/` (hermesPaths),
 * the agents' HOME, HERMES_HOME and work folders included. `host` is the Hermes host
 * sub-port (start, stop, status, assertStopped and the lifecycle methods above);
 * `maintenance` as for OpenClaw (runtime-updates.js).
 */
export function createHermesUpdates({ dataDir, host, maintenance, ...options }) {
  return new RuntimeUpdates({
    ...options,
    dataDir,
    maintenance,
    paths: hermesPaths(dataDir),
    host,
  });
}
