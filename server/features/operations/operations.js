import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { Doctor } from "./doctor.js";
import { Backup } from "./backup.js";
import { Restore } from "./restore.js";
import { Releases } from "./releases.js";
import { OperationJobs } from "./jobs.js";
import { atomic, readJson, identifier } from "./files.js";
import { problem } from "../../lib/storage.js";
import { ImportedHistory } from "./imported-history.js";
import { removeAbandonedWork } from "./work-claims.js";
// The audited resource of each non-release job kind; release-* jobs are "release".
const jobResources = { backup: "backup", restore: "restore" };
export class Operations {
  constructor({
    config,
    audit,
    withSnapshotBarrier,
    assistantsBusy,
    doctorOptions = {},
    releaseOptions = {},
  }) {
    config = { ...config, dataDir: fs.realpathSync(config.dataDir) };
    // Only the server cleans up, once: work another process (such as
    // scripts/operations.mjs) still claims is kept.
    removeAbandonedWork(config.dataDir);
    this.config = config;
    this.audit = audit;
    this.backup = new Backup({ ...config, audit, withSnapshotBarrier, assistantsBusy });
    this.restore = new Restore({ ...config, audit });
    // Uploads and uploaded archives outlive a restart until they expire.
    this.restore.uploads.sweep();
    this.releases = new Releases({ ...config, ...releaseOptions });
    this.doctor = new Doctor({ ...config, ...doctorOptions });
    this.importedHistory = new ImportedHistory(config.dataDir);
    this.jobs = new OperationJobs(config.dataDir, {
      onFailure: (job) => {
        const resourceType = job.kind.startsWith("release-")
          ? "release"
          : jobResources[job.kind];
        this.audit?.append({
          action: `${resourceType}.failed`,
          resourceType,
          resourceId: job.id,
          outcome: "failure",
          source: "user",
        });
      },
    });
    this.reportFile = path.join(config.dataDir, "operations/doctor.json");
    this.postActivationMarker = path.join(
      config.dataDir,
      "operations/post-activation-reload.json",
    );
  }
  report() {
    return readJson(this.reportFile, null);
  }
  async diagnose(input) {
    let report;
    try {
      report = await this.doctor.run(input);
    } catch (error) {
      this.audit?.append({
        action: "diagnostic.failed",
        resourceType: "diagnostic",
        outcome: "failure",
        source: "user",
      });
      throw error;
    }
    atomic(this.reportFile, report);
    this.audit?.append({
      action: "diagnostic.completed",
      resourceType: "diagnostic",
      outcome: "success",
      source: "user",
    });
    return report;
  }
  createBackup(input) {
    return this.jobs.start("backup", async () => {
      const { file: _file, ...result } = await this.backup.create(input);
      return result;
    });
  }
  /**
   * The archive `archiveId` names: an uploaded one (`uploaded`, kept from expiring
   * until `release`) or a backup of this host.
   */
  archive(archiveId) {
    const id = identifier(archiveId);
    const upload = path.resolve(this.restore.directory, `${id}.apbackup`);
    if (!upload.startsWith(`${this.restore.directory}${path.sep}`))
      throw problem(serverMessages.operations.invalidIdentifier);
    const release = this.restore.uploads.read(id);
    if (release) return { file: upload, uploaded: true, release };
    const backup = this.backup.file(id);
    if (fs.existsSync(backup)) return { file: backup, uploaded: false, release() {} };
    throw problem(serverMessages.operations.uploadNotFound, 404);
  }
  async inspect({ archiveId, ...input }) {
    const archive = this.archive(archiveId);
    try {
      return await this.restore.inspect({ ...input, archive: archive.file });
    } finally {
      archive.release();
    }
  }
  applyRestore({ archiveId, ...input }) {
    const archive = this.archive(archiveId);
    try {
      return this.jobs.start("restore", async () => {
        try {
          const result = await this.restore.apply({ ...input, archive: archive.file });
          // The upload served its purpose; a failed restore keeps it for a retry.
          if (archive.uploaded) this.restore.uploads.discard(identifier(archiveId));
          return result;
        } finally {
          archive.release();
        }
      });
    } catch (error) {
      archive.release();
      throw error;
    }
  }
  stage(input) {
    return this.jobs.start("release-stage", async () => {
      const result = await this.releases.stage(input);
      this.audit?.append({
        action: "release.staged",
        resourceType: "release",
        resourceId: result.stagedId,
        outcome: "success",
        source: "user",
      });
      return result;
    });
  }
  requireNoMigration() {
    if (this.jobs.running("release-migrate"))
      throw problem(serverMessages.operations.migrationRunning, 409);
  }
  /** The owner stops a version's orphaned processes (release-cleanup.js). */
  async stopOrphanedProcesses(version, { pids }) {
    const result = await this.releases.stopOrphans(version, pids);
    this.audit?.append({
      action: "release.stopped",
      resourceType: "release",
      outcome: "success",
      source: "user",
      details: { version, count: result.stopped.length },
    });
    return result;
  }
  cleanupReleases({ versions }) {
    this.requireNoMigration();
    return this.jobs.start("release-cleanup", async (jobId) => {
      const result = await this.releases.cleanup(versions);
      for (const version of result.removedVersions)
        this.audit?.append({
          action: "release.deleted",
          resourceType: "release",
          resourceId: jobId,
          outcome: "success",
          source: "user",
          details: {
            version,
            ...(result.stagedIds?.[version]
              ? { stagedId: result.stagedIds[version] }
              : {}),
          },
        });
      return result;
    });
  }
  activate({ reloadSessions, ...input }) {
    if (reloadSessions !== undefined && typeof reloadSessions !== "boolean")
      throw problem(serverMessages.operations.invalidOptions);
    this.requireNoMigration();
    const target =
      reloadSessions === true && input.stagedId
        ? this.releases.stagedVersion(input.stagedId)
        : null;
    return this.jobs.start(
      input.stagedId ? "release-activate" : "release-rollback",
      async (jobId) => {
        await this.releases.launchActivation(input, jobId);
        if (target)
          atomic(this.postActivationMarker, {
            to: target,
            jobId,
            requestedAt: new Date().toISOString(),
          });
      },
      { external: true },
    );
  }
  async close() {
    await this.jobs.close();
  }
}
