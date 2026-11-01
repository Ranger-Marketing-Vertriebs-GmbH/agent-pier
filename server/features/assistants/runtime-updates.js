import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePaths, privateFolder } from "./runtime-paths.js";
import { runtimeFor } from "./runtimes/runtime-for.js";
import { readJSON } from "../../lib/storage.js";
import {
  durablePrivate,
  createUpdateSnapshot,
  estimateSnapshotSize,
  restoreUpdateSnapshot,
  verifyUpdateSnapshot,
} from "./runtime-update-snapshot.js";
import { ledgerFence } from "./ledger-fence.js";
import { blockerCodes, publicItem } from "./runtime-update-blockers.js";
import {
  applyRetention,
  listBackups,
  markBackupSuccessful,
  removeBackup,
  terminalPhases as terminal,
} from "./runtime-retention.js";

const failure = (code, status = 503) => Object.assign(Error(code), { code, status });
async function availableBytes(directory) {
  const stat = await fsp.statfs(directory);
  return stat.bavail * stat.bsize;
}
/**
 * AgentPier's update journal for the runtime host: staging, the owner's activation in
 * maintenance with a snapshot, validation, rollback and recovery. What is particular
 * to the runtime (installing, the shipped version, migrating its state) goes through
 * the host sub-port of `runtime` (runtimes/agent-runtime.js). `stage`, `migrate` and
 * `stopMigration` replace host.install, host.migrate and host.stopMigration, and
 * `host` any other host method (tests).
 */
export class RuntimeUpdates {
  constructor({
    dataDir,
    runtime,
    maintenance,
    stage,
    affected = () => ({ agents: 0, teamMembers: 0 }),
    isBlocked = () => false,
    freeSpace = availableBytes,
    onRolledBack = () => {},
    migrate,
    stopMigration,
    host = {},
  }) {
    Object.assign(this, {
      dataDir,
      runtime,
      maintenance,
      affected,
      isBlocked,
      freeSpace,
      onRolledBack,
    });
    this.host = {
      ...runtimeFor(null, runtime).host,
      ...(stage && { install: stage }),
      ...(migrate && { migrate }),
      ...(stopMigration && { stopMigration }),
      ...host,
    };
    this.paths = runtimePaths(dataDir);
    this.fence = ledgerFence(this.paths.root);
    this.file = path.join(this.paths.root, "update.json");
    this.selection = path.join(this.paths.root, "runtime.json");
    this.candidateFile = path.join(this.paths.root, "candidate.json");
    try {
      this.journal = readJSON(this.file, { phase: "idle" });
      if (!this.journal || typeof this.journal.phase !== "string")
        throw Error("Invalid update journal.");
    } catch {
      this.journal = {
        phase: "recovery_required",
        invalid: true,
        diagnostic: "UPDATE_RECOVERY_REQUIRED",
      };
    }
    this.busy = false;
    this.progress = null;
    // Hears every change of status(): a phase, busy, the snapshot's progress (its
    // live topic, live-runtime-topics.js).
    this.onChange = null;
  }
  /** status() changed; a failing listener is logged, the update goes on. */
  changed() {
    try {
      this.onChange?.();
    } catch {
      console.error("AgentPier could not report an agent runtime update change.");
    }
  }
  status() {
    const selected = readJSON(this.selection, null);
    const stored = readJSON(this.candidateFile, null);
    const candidate = stored && !this.host.sameInstall(stored, selected) ? stored : null;
    const affected = this.affected();
    const target = this.host.target();
    return {
      phase: this.journal.phase,
      currentVersion: selected?.version || null,
      targetVersion: candidate?.version || target.version,
      nodeVersion: candidate?.nodeVersion || target.nodeVersion,
      candidateReady: !!candidate,
      updateAvailable: !!candidate || !this.host.current(selected),
      // The owner's agents; temporary team members are counted apart.
      affectedAssistants: affected.agents,
      affectedTeamMembers: affected.teamMembers,
      blockers: this.journal.blockers || [],
      // Each blocker of the last refused activation (runtime-update-blockers.js).
      blockerItems: this.journal.blockerItems || [],
      diagnostic: this.journal.diagnostic || null,
      diagnosticPath: this.journal.diagnosticPath || null,
      // Bytes copied so far against the pre-check's estimate, while this process copies.
      snapshotProgress:
        this.journal.phase === "snapshotting" && this.progress
          ? {
              copiedBytes: Math.min(this.progress.copiedBytes, this.progress.totalBytes),
              totalBytes: this.progress.totalBytes,
            }
          : null,
      recoveryRequired:
        (!terminal.has(this.journal.phase) && this.journal.phase !== "staging") ||
        !!this.maintenance.recoveryState?.(),
      busy: this.busy,
    };
  }
  persist(phase, changes = {}) {
    const next = { ...this.journal, ...changes, phase };
    durablePrivate(this.file, next);
    this.journal = next;
    this.changed();
  }
  async exclusive(operation) {
    if (this.busy || this.isBlocked()) throw failure("UPDATE_BUSY", 409);
    this.busy = true;
    this.changed();
    try {
      return await operation();
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  stage() {
    return this.exclusive(async () => {
      if (!terminal.has(this.journal.phase))
        throw failure("UPDATE_RECOVERY_REQUIRED", 409);
      const before = this.journal.phase;
      this.persist("staging", {
        diagnostic: null,
        diagnosticPath: null,
        blockers: [],
        blockerItems: [],
      });
      try {
        const candidate = await this.host.install({ dataDir: this.dataDir });
        if (this.host.sameInstall(candidate, readJSON(this.selection, null))) {
          // The selected runtime already is the qualified one: nothing to activate.
          fs.rmSync(this.candidateFile, { force: true });
          this.persist("idle");
        } else {
          durablePrivate(this.candidateFile, candidate);
          this.persist("staged");
        }
        return this.status();
      } catch (error) {
        const busy = error.code === "RUNTIME_BUSY";
        const staged = readJSON(this.candidateFile, null) ? "staged" : "idle";
        this.persist(busy ? before : staged, {
          diagnostic: busy ? "RUNTIME_BUSY" : "UPDATE_STAGE_FAILED",
        });
        throw busy ? failure("RUNTIME_BUSY", 409) : failure("UPDATE_STAGE_FAILED");
      }
    });
  }
  /**
   * `resolveBlockers` ("Pause agents and update"): the blocker items the owner
   * confirmed (`items`: ids and revisions) are resolved in maintenance before the
   * activation (AssistantMaintenance.resolve); without it, any blocker refuses.
   */
  activate({ resolveBlockers = false, items = [] } = {}) {
    return this.exclusive(async () => {
      if (!terminal.has(this.journal.phase))
        throw failure("UPDATE_RECOVERY_REQUIRED", 409);
      const candidate = readJSON(this.candidateFile, null);
      const previous = readJSON(this.selection, null);
      if (!candidate || !previous || this.host.sameInstall(candidate, previous))
        throw failure("UPDATE_NOT_STAGED", 409);
      // Refuse before maintenance or any copy when the backup cannot fit twice over.
      const estimate = await estimateSnapshotSize(this.paths);
      if ((await this.freeSpace(this.paths.root)) < 2 * estimate) {
        this.persist(this.journal.phase, { diagnostic: "INSUFFICIENT_SPACE" });
        throw failure("INSUFFICIENT_SPACE", 507);
      }
      const wasRunning = this.host.status().availability !== "disabled";
      const id = randomUUID();
      this.journal = {
        phase: "staged",
        candidate,
        previous,
        wasRunning,
        id,
        blockers: [],
        blockerItems: [],
      };
      this.persist("draining");
      let stopped = false;
      try {
        await this.maintenance.enter();
        // A maintenance without items (a test double) reports its codes only.
        const found = !this.maintenance.blockerItems
          ? null
          : resolveBlockers
            ? await this.maintenance.resolve(items)
            : await this.maintenance.blockerItems();
        const blockers = found ? blockerCodes(found) : await this.maintenance.blockers();
        if (blockers.length) {
          this.persist("staged", {
            blockers,
            blockerItems: (found || []).map(publicItem),
            diagnostic: "UPDATE_BLOCKED",
          });
          await this.maintenance.leave();
          throw failure("UPDATE_BLOCKED", 409);
        }
        await this.host.stop();
        stopped = true;
        await this.maintenance.quiesce();
        await this.host.assertStopped();
        const remaining = await this.maintenance.blockers();
        if (remaining.length) throw failure("UPDATE_BLOCKED", 409);
        this.fence.close();
        this.persist("snapshotting");
        const backup = path.join(
          privateFolder(path.join(this.paths.root, "backups")),
          id,
        );
        this.progress = { copiedBytes: 0, totalBytes: estimate };
        try {
          await createUpdateSnapshot(
            this.paths,
            backup,
            { previous, candidate, createdAt: Date.now() },
            {
              onProgress: (bytes) => {
                this.progress.copiedBytes += bytes;
                this.changed();
              },
            },
          );
        } finally {
          this.progress = null;
        }
        this.persist("activating", { backup: id });
        durablePrivate(this.selection, candidate);
        // A new version migrates its stopped state (host.migrate: OpenClaw's Doctor);
        // a crash meanwhile restores the snapshot like any unfinished activation.
        if (candidate.version !== previous.version) {
          this.persist("migrating");
          // Its identity is durable before it is awaited: a rollback after a crash
          // stops a migration that outlived this process (host.stopMigration).
          await this.host.migrate(this.paths, candidate, {
            onSpawn: (doctor) => this.persist("migrating", { doctor }),
          });
          this.persist("migrating", { doctor: null });
        }
        await this.fence.validation(async () => {
          await this.host.start();
          this.persist("validating");
          await this.maintenance.validate();
        });
        // Rows the validation itself inserted are recorded so rollback excludes them too.
        this.persist("validating", { validationWrites: this.fence.writes() });
        await verifyUpdateSnapshot(this.paths, backup, this.journal.validationWrites);
        // This durable boundary forbids stale-state rollback even if resume or the
        // process crashes immediately afterward.
        this.persist("committed");
        markBackupSuccessful(this.paths, id);
        this.fence.open();
        if (!wasRunning) await this.host.stop();
        await this.maintenance.leave();
        this.persist("complete");
        await this.retain();
        return this.status();
      } catch (error) {
        if (this.journal.phase === "staged") throw error;
        if (this.journal.phase === "committed") {
          this.persist("committed", { diagnostic: "UPDATE_RESUME_REQUIRED" });
          throw failure("UPDATE_RESUME_REQUIRED");
        }
        if (!stopped) {
          // Nothing changed yet: the old version keeps running. UPDATE_BLOCKED always
          // names its blockers (above); a Gateway that refused the scheduler pause
          // (its config.patch budget, live-patch.js) or another failure before the
          // stop says so instead.
          const diagnostic =
            error.code === "CONFIG_BUSY" ? "UPDATE_CONFIG_BUSY" : "UPDATE_PREPARE_FAILED";
          this.persist("staged", { diagnostic, blockers: [], blockerItems: [] });
          await this.maintenance.leave();
          throw failure(diagnostic);
        }
        await this.rollback();
        if (error.code === "SNAPSHOT_FAILED")
          this.persist("rolled_back", {
            diagnostic: "SNAPSHOT_FAILED",
            diagnosticPath: error.path,
          });
        if (error.code === "UPDATE_MIGRATION_FAILED") {
          if (this.journal.diagnostic === "UPDATE_ROLLED_BACK")
            this.persist("rolled_back", { diagnostic: "UPDATE_MIGRATION_FAILED" });
          throw failure("UPDATE_MIGRATION_FAILED", 500);
        }
        throw failure("UPDATE_ROLLED_BACK");
      }
    });
  }
  async rollback() {
    const journal = this.journal;
    try {
      this.persist("rolling_back");
      // Nothing may write under the restore: a migration left running goes first.
      await this.host.stopMigration(journal.doctor);
      await this.host.stop();
      await this.maintenance.quiesce();
      await this.host.assertStopped();
      let diagnostic = "UPDATE_ROLLED_BACK";
      if (journal.backup) {
        if (journal.backup !== journal.id || !/^[a-f0-9-]{36}$/.test(journal.backup))
          throw Error("Invalid snapshot identity.");
        const backup = path.join(
          privateFolder(path.join(this.paths.root, "backups")),
          journal.backup,
        );
        const restored = await restoreUpdateSnapshot(
          this.paths,
          backup,
          journal.validationWrites || [],
        );
        if (JSON.stringify(restored.previous) !== JSON.stringify(journal.previous))
          throw Error("Snapshot runtime mismatch.");
        // A credential revoked after the backup stays revoked: its key is gone.
        if (restored.credentialsWithheld)
          diagnostic = "UPDATE_ROLLED_BACK_LOGIN_REQUIRED";
        // A migration's leftovers lie beside state/, outside every restored tree.
        this.host.clearMigration(this.paths);
        // Before the Gateway starts on the restored state (MCP OAuth logouts).
        await this.onRolledBack({ createdAt: restored.createdAt });
      }
      this.fence.open();
      durablePrivate(this.selection, journal.previous);
      if (journal.wasRunning) {
        await this.host.start();
        await this.maintenance.validate();
      }
      this.persist("rollback_committed", { diagnostic });
      await this.maintenance.leave();
      this.persist("rolled_back");
      await this.retain();
    } catch {
      await this.host.stop();
      if (this.journal.phase === "rollback_committed") {
        this.persist("rollback_committed", { diagnostic: "UPDATE_RESUME_REQUIRED" });
        throw failure("UPDATE_RESUME_REQUIRED");
      }
      this.persist("recovery_required", { diagnostic: "UPDATE_RECOVERY_REQUIRED" });
      throw failure("UPDATE_RECOVERY_REQUIRED");
    }
  }
  recover() {
    return this.exclusive(async () => {
      if (this.journal.phase === "staging") {
        this.persist(readJSON(this.candidateFile, null) ? "staged" : "idle", {
          diagnostic: "UPDATE_STAGE_INTERRUPTED",
        });
      }
      if (terminal.has(this.journal.phase)) {
        const orphan = this.maintenance.recoveryState?.();
        if (!orphan) return this.status();
        // A provider mutation may already have committed outside the update
        // transaction. Resume current state; no old snapshot may be restored.
        const selected = readJSON(this.selection, null) || {};
        this.journal = {
          phase: "committed",
          previous: selected,
          candidate: selected,
          wasRunning: orphan.wasRunning === true,
          diagnostic: "UPDATE_RESUME_REQUIRED",
        };
        this.persist("committed");
      }
      await this.maintenance.enter();
      if (this.journal.invalid || !this.journal.previous || !this.journal.candidate) {
        await this.host.stop();
        throw failure("UPDATE_RECOVERY_REQUIRED");
      }
      if (["committed", "rollback_committed"].includes(this.journal.phase)) {
        const completed = this.journal.phase === "committed" ? "complete" : "rolled_back";
        // Work may already have resumed. Preserve current state and selection.
        if (this.journal.phase === "committed" && this.journal.backup)
          markBackupSuccessful(this.paths, this.journal.backup);
        this.fence.open();
        if (this.journal.wasRunning) {
          await this.host.start();
          await this.maintenance.validate();
        }
        await this.maintenance.leave();
        this.persist(completed, { diagnostic: null });
        await this.retain();
      } else await this.rollback();
      return this.status();
    });
  }
  /**
   * What would block an activation now, item by item, read without changing anything
   * (the confirmation of "Pause agents and update"); none while an update runs.
   */
  async blockerPreview() {
    if (this.busy || !this.maintenance.blockerItems) return [];
    return (await this.maintenance.blockerItems({ settle: false })).map(publicItem);
  }
  /** The update backups with what each may still be needed for (runtime-retention.js). */
  backups() {
    return listBackups(this.paths, this.journal);
  }
  /**
   * Deletes one update backup and its key the way retention does, on the owner's
   * request (System status). Refused while an update or a recovery may still need a
   * backup: during any update phase, a pending rollback or an unresolved recovery.
   */
  deleteBackup(id) {
    return this.exclusive(async () => {
      if (!terminal.has(this.journal.phase) || this.status().recoveryRequired)
        throw failure("UPDATE_RECOVERY_REQUIRED", 409);
      // The id on disk, found by lookup, names the folder; never the caller's string.
      const found = this.backups().find((backup) => backup.id === id);
      if (!found) throw failure("UPDATE_BACKUP_NOT_FOUND", 404);
      await removeBackup(this.paths, found.id);
      return found;
    });
  }
  // Retention never decides whether an update succeeded; a cleanup failure is retried
  // after the next update instead of turning a completed update into an error.
  async retain() {
    try {
      await applyRetention(this.paths, this.journal);
    } catch {
      /* Retried after the next update. */
    }
  }
}
