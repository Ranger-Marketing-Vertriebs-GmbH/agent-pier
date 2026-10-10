import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePaths, privateFolder } from "./runtime-paths.js";
import { sameRuntime, stageAssistantRuntime } from "./runtime-install.js";
import { runtimeManifest } from "./runtime-manifest.js";
import { readJSON } from "../../lib/storage.js";
import {
  durablePrivate,
  createUpdateSnapshot,
  estimateSnapshotSize,
  restoreUpdateSnapshot,
  verifyUpdateSnapshot,
} from "./runtime-update-snapshot.js";
import { ledgerFence } from "./ledger-fence.js";
import {
  applyRetention,
  markBackupSuccessful,
  terminalPhases as terminal,
} from "./runtime-retention.js";

const failure = (code, status = 503) => Object.assign(Error(code), { code, status });
async function availableBytes(directory) {
  const stat = await fsp.statfs(directory);
  return stat.bavail * stat.bsize;
}
const matchesManifest = (selected, manifest) =>
  !!selected &&
  selected.version === manifest.version &&
  selected.nodeVersion === manifest.nodeVersion &&
  selected.dependencyLockSha256 === manifest.dependencyLockSha256;
export class RuntimeUpdates {
  constructor({
    dataDir,
    runtime,
    maintenance,
    stage = stageAssistantRuntime,
    affected = () => ({ agents: 0, teamMembers: 0 }),
    isBlocked = () => false,
    freeSpace = availableBytes,
    manifest = runtimeManifest,
  }) {
    Object.assign(this, {
      dataDir,
      runtime,
      maintenance,
      install: stage,
      affected,
      isBlocked,
      freeSpace,
      manifest,
    });
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
  }
  status() {
    const selected = readJSON(this.selection, null);
    const stored = readJSON(this.candidateFile, null);
    const candidate = stored && !sameRuntime(stored, selected) ? stored : null;
    const affected = this.affected();
    return {
      phase: this.journal.phase,
      currentVersion: selected?.version || null,
      targetVersion: candidate?.version || this.manifest.version,
      nodeVersion: candidate?.nodeVersion || this.manifest.nodeVersion,
      candidateReady: !!candidate,
      updateAvailable: !!candidate || !matchesManifest(selected, this.manifest),
      // The owner's agents; temporary team members are counted apart.
      affectedAssistants: affected.agents,
      affectedTeamMembers: affected.teamMembers,
      blockers: this.journal.blockers || [],
      diagnostic: this.journal.diagnostic || null,
      diagnosticPath: this.journal.diagnosticPath || null,
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
  }
  async exclusive(operation) {
    if (this.busy || this.isBlocked()) throw failure("UPDATE_BUSY", 409);
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
  stage() {
    return this.exclusive(async () => {
      if (!terminal.has(this.journal.phase))
        throw failure("UPDATE_RECOVERY_REQUIRED", 409);
      const before = this.journal.phase;
      this.persist("staging", { diagnostic: null, diagnosticPath: null, blockers: [] });
      try {
        const candidate = await this.install({ dataDir: this.dataDir });
        if (sameRuntime(candidate, readJSON(this.selection, null))) {
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
  activate() {
    return this.exclusive(async () => {
      if (!terminal.has(this.journal.phase))
        throw failure("UPDATE_RECOVERY_REQUIRED", 409);
      const candidate = readJSON(this.candidateFile, null);
      const previous = readJSON(this.selection, null);
      if (!candidate || !previous || sameRuntime(candidate, previous))
        throw failure("UPDATE_NOT_STAGED", 409);
      // Refuse before maintenance or any copy when the backup cannot fit twice over.
      if (
        (await this.freeSpace(this.paths.root)) <
        2 * (await estimateSnapshotSize(this.paths))
      ) {
        this.persist(this.journal.phase, { diagnostic: "INSUFFICIENT_SPACE" });
        throw failure("INSUFFICIENT_SPACE", 507);
      }
      const wasRunning = this.runtime.status().availability !== "disabled";
      const id = randomUUID();
      this.journal = {
        phase: "staged",
        candidate,
        previous,
        wasRunning,
        id,
        blockers: [],
      };
      this.persist("draining");
      let stopped = false;
      try {
        await this.maintenance.enter();
        const blockers = await this.maintenance.blockers();
        if (blockers.length) {
          this.persist("staged", { blockers, diagnostic: "UPDATE_BLOCKED" });
          await this.maintenance.leave();
          throw failure("UPDATE_BLOCKED", 409);
        }
        await this.runtime.stop();
        stopped = true;
        await this.maintenance.quiesce();
        await this.runtime.assertStopped?.();
        const remaining = await this.maintenance.blockers();
        if (remaining.length) throw failure("UPDATE_BLOCKED", 409);
        this.fence.close();
        this.persist("snapshotting");
        const backup = path.join(
          privateFolder(path.join(this.paths.root, "backups")),
          id,
        );
        await createUpdateSnapshot(this.paths, backup, {
          previous,
          candidate,
          createdAt: Date.now(),
        });
        this.persist("activating", { backup: id });
        durablePrivate(this.selection, candidate);
        await this.fence.validation(async () => {
          await this.runtime.start();
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
        if (!wasRunning) await this.runtime.stop();
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
          this.persist("staged", { diagnostic: "UPDATE_BLOCKED" });
          await this.maintenance.leave();
          throw failure("UPDATE_BLOCKED", 409);
        }
        await this.rollback();
        if (error.code === "SNAPSHOT_FAILED")
          this.persist("rolled_back", {
            diagnostic: "SNAPSHOT_FAILED",
            diagnosticPath: error.path,
          });
        throw failure("UPDATE_ROLLED_BACK");
      }
    });
  }
  async rollback() {
    const journal = this.journal;
    try {
      this.persist("rolling_back");
      await this.runtime.stop();
      await this.maintenance.quiesce();
      await this.runtime.assertStopped?.();
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
      }
      this.fence.open();
      durablePrivate(this.selection, journal.previous);
      if (journal.wasRunning) {
        await this.runtime.start();
        await this.maintenance.validate();
      }
      this.persist("rollback_committed", { diagnostic });
      await this.maintenance.leave();
      this.persist("rolled_back");
      await this.retain();
    } catch {
      await this.runtime.stop();
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
        await this.runtime.stop();
        throw failure("UPDATE_RECOVERY_REQUIRED");
      }
      if (["committed", "rollback_committed"].includes(this.journal.phase)) {
        const completed = this.journal.phase === "committed" ? "complete" : "rolled_back";
        // Work may already have resumed. Preserve current state and selection.
        if (this.journal.phase === "committed" && this.journal.backup)
          markBackupSuccessful(this.paths, this.journal.backup);
        this.fence.open();
        if (this.journal.wasRunning) {
          await this.runtime.start();
          await this.maintenance.validate();
        }
        await this.maintenance.leave();
        this.persist(completed, { diagnostic: null });
        await this.retain();
      } else await this.rollback();
      return this.status();
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
