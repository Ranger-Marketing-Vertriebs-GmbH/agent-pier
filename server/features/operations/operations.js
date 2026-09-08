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
export class Operations {
  constructor({
    config,
    audit,
    withSnapshotBarrier,
    doctorOptions = {},
    releaseOptions = {},
  }) {
    config = { ...config, dataDir: fs.realpathSync(config.dataDir) };
    this.config = config;
    this.audit = audit;
    this.backup = new Backup({ ...config, audit, withSnapshotBarrier });
    this.restore = new Restore({ ...config, audit });
    this.releases = new Releases({ ...config, ...releaseOptions });
    this.doctor = new Doctor({ ...config, ...doctorOptions });
    this.importedHistory = new ImportedHistory(config.dataDir);
    this.jobs = new OperationJobs(config.dataDir, {
      onFailure: (job) => {
        const resourceType = job.kind.startsWith("release-") ? "release" : job.kind;
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
  archive(archiveId) {
    identifier(archiveId);
    const upload = path.join(this.restore.directory, `${archiveId}.apbackup`);
    const backup = this.backup.file(archiveId);
    if (fs.existsSync(upload)) return upload;
    if (fs.existsSync(backup)) return backup;
    throw problem("Uploaded archive not found.", 404);
  }
  inspect({ archiveId, ...input }) {
    return this.restore.inspect({ ...input, archive: this.archive(archiveId) });
  }
  applyRestore({ archiveId, ...input }) {
    const archive = this.archive(archiveId);
    return this.jobs.start("restore", () => this.restore.apply({ ...input, archive }));
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
  activate(input) {
    return this.jobs.start(
      input.stagedId ? "release-activate" : "release-rollback",
      (jobId) => this.releases.launchActivation(input, jobId),
      { external: true },
    );
  }
  async close() {
    await this.jobs.close();
  }
}
