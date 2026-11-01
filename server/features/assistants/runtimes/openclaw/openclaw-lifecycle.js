import { runtimeManifest } from "./runtime-manifest.js";
import { sameRuntime, shippedRuntime, stageAssistantRuntime } from "./runtime-install.js";
import { stageRuntimeInBackground } from "./runtime-provisioning.js";
import {
  migrateRuntimeState,
  removeMigrationLeftovers,
  stopDoctor,
} from "./runtime-doctor.js";

/**
 * The install, update, rollback and restart-reason methods of the OpenClaw host
 * sub-port (../agent-runtime.js). AgentPier's own lifecycle (runtime-updates.js,
 * pending-restart.js) decides when; these do what is particular to OpenClaw: its
 * pinned npm package and Node (runtime-manifest.js, runtime-install.js), the Doctor
 * migration of its state (runtime-doctor.js) and the supervisor's Gateway generation.
 * Install records are the descriptors runtime-install.js writes (`runtime.json`,
 * `candidate.json`); AgentPier keeps them as opaque objects.
 */
export function openClawLifecycle(supervisor) {
  return {
    // Installs the version this AgentPier ships beside the selected one under the
    // shared installation lock; resolves its record.
    install: (options) => stageAssistantRuntime(options),
    // Whether two install records name the same installation.
    sameInstall: (a, b) => sameRuntime(a, b),
    // The version this AgentPier ships, and whether an install record is it.
    target: () => ({
      version: runtimeManifest.version,
      nodeVersion: runtimeManifest.nodeVersion,
    }),
    current: (record) => shippedRuntime(record),
    // After an AgentPier update: installs the shipped version in the background when
    // the selected one is outdated; the job, or null when nothing is due.
    stageUpdate: (options) => stageRuntimeInBackground(options),
    // Migrates the stopped state to `record`'s version (OpenClaw's Doctor);
    // `onSpawn(handle)` receives the migration process to record before it is awaited.
    migrate: (paths, record, options) => migrateRuntimeState(paths, record, options),
    // Rollback: stops a migration that outlived its process (its recorded handle),
    // and removes what a migration left beside the restored state.
    stopMigration: (handle) => stopDoctor(handle),
    clearMigration: (paths) => removeMigrationLeftovers(paths),
    // Rejects while a Gateway process of this host still runs.
    assertStopped: async () => supervisor.assertStopped?.(),
    // The Gateway start that compiled the configuration now running, or null: a
    // start of another generation loaded every change saved before it.
    generation: () => supervisor.generationId ?? null,
    // Whether a saved change a running Gateway cannot load needs a restart: not while
    // stopped, as the next start compiles it; a starting Gateway may have compiled
    // before the save, so it counts as running.
    restartNeeded() {
      const availability = supervisor.status?.().availability;
      return availability ? availability !== "disabled" : !!supervisor.client?.ready;
    },
  };
}
