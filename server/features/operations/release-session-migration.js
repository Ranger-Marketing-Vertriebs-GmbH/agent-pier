import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { releaseVersion } from "./release-archive.js";
import { readJson } from "./files.js";
import { problem } from "../../lib/storage.js";

const migrateError = (code, message, status = 409, result) =>
  Object.assign(problem(message, status), { code, ...(result ? { result } : {}) });
const inFlight = (state) => ["waiting", "reloading"].includes(state);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const partial = (tracked) => ({
  failedSessions: [...tracked]
    .filter(([, item]) => item.outcome === "failed")
    .map(([id, item]) => ({ id, error: item.error || null })),
  reloadedSessions: [...tracked]
    .filter(([, item]) => item.outcome === "reloaded")
    .map(([id]) => id),
});

/** Moves sessions off an old release via session reload, then removes the release. */
export class ReleaseSessionMigration {
  constructor({
    services,
    operations,
    pollMs = 1000,
    settleAttempts = 30,
    activationTimeoutMs = 600000,
    log = console.error,
  }) {
    this.services = services;
    this.operations = operations;
    this.pollMs = pollMs;
    this.settleAttempts = settleAttempts;
    this.activationTimeoutMs = activationTimeoutMs;
    this.activationPollMs = 2000;
    this.log = log;
    this.active = null;
    this.marker = operations.postActivationMarker;
  }
  entry(version) {
    const state = this.operations.releases.cleanupStatus();
    return state.available
      ? state.versions.find((item) => item.version === version) || null
      : null;
  }
  async describe(id) {
    let session;
    try {
      session = await this.services.sessions.get(id);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    let status;
    try {
      status = await this.services.reload.status(id);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    return {
      id,
      name: session.name || null,
      tool: session.tool,
      status: session.status,
      eligible: status.eligible,
      reason: status.reason,
      activity: status.activity.state,
      reload: status.state,
      reloadError: status.error,
      reloadSince: session.reload?.updatedAt || null,
    };
  }
  async plan(version) {
    releaseVersion(version);
    const entry = this.entry(version);
    const base = {
      version,
      deleteReason: entry ? entry.deleteReason : "unsafe",
      migratable: false,
      migrating: this.active?.version === version,
      nodeOnlyProcesses: 0,
      unidentifiedProcesses: [],
      sessions: [],
    };
    if (!entry || entry.deleteReason !== "inUse") return base;
    const sessions = (
      await Promise.all(entry.sessionIds.map((id) => this.describe(id)))
    ).filter(Boolean);
    return {
      ...base,
      nodeOnlyProcesses: entry.nodeOnlyProcesses,
      unidentifiedProcesses: entry.unidentifiedProcesses,
      sessions,
      migratable:
        !entry.unidentifiedProcesses.length &&
        sessions.every((session) => session.eligible || inFlight(session.reload)),
    };
  }
  migrate(version, options = {}) {
    releaseVersion(version);
    if (options === null || typeof options !== "object" || Array.isArray(options))
      throw problem("Invalid operation options.");
    const { interrupt = false } = options;
    if (typeof interrupt !== "boolean") throw problem("Invalid operation options.");
    if (this.active || this.operations.jobs.running("release-"))
      throw migrateError(
        "migrateBusy",
        "Another release operation is running. Wait for it to finish.",
      );
    const control = { version, cancelled: false };
    const job = this.operations.jobs.start("release-migrate", async (jobId) => {
      try {
        return await this.run(version, interrupt, control, jobId);
      } finally {
        if (this.active === control) this.active = null;
      }
    });
    this.active = control;
    return job;
  }
  cancel(version) {
    releaseVersion(version);
    if (!this.active || this.active.version !== version)
      throw problem("No migration is running for this release.", 404);
    this.active.cancelled = true;
  }
  checkpoint(control, tracked) {
    if (control.cancelled)
      throw migrateError(
        "migrateCancelled",
        "The migration was cancelled. The release was kept.",
        409,
        partial(tracked),
      );
    if (this.operations.jobs.closed)
      throw migrateError(
        "migrateInterrupted",
        "The web service is shutting down. The release was kept.",
        503,
        partial(tracked),
      );
  }
  async run(version, interrupt, control, jobId) {
    const plan = await this.plan(version);
    if (!plan.migratable)
      throw migrateError(
        "migrateChanged",
        "The sessions of this release changed. Refresh the list.",
      );
    const tracked = new Map();
    for (const session of plan.sessions) {
      this.checkpoint(control, tracked);
      if (inFlight(session.reload)) {
        tracked.set(session.id, { requestId: null, wasInFlight: true });
        continue;
      }
      // A session that is no longer running holds no process; it vanishes from `ps`.
      if (session.status !== "running") {
        tracked.set(session.id, { requestId: null, outcome: "released" });
        continue;
      }
      const requestId = randomUUID();
      try {
        await this.services.reload.request(
          session.id,
          interrupt
            ? { requestId, mode: "now", interrupt: true }
            : { requestId, mode: "when-idle" },
        );
        tracked.set(session.id, { requestId });
      } catch (error) {
        tracked.set(session.id, { requestId, outcome: "failed", error: error.message });
      }
    }
    await this.settle(tracked, control);
    const result = partial(tracked);
    if (result.failedSessions.length)
      throw migrateError(
        "migrateFailed",
        "Some sessions could not be reloaded. The release was kept.",
        409,
        result,
      );
    await this.awaitReferences(version, control, tracked);
    this.checkpoint(control, tracked);
    const cleanup = await this.operations.releases.cleanup([version]);
    this.operations.audit?.append({
      action: "release.deleted",
      resourceType: "release",
      resourceId: jobId,
      outcome: "success",
      source: "user",
      details: { version, count: result.reloadedSessions.length },
    });
    return {
      reloadedSessions: result.reloadedSessions,
      removedVersions: cleanup.removedVersions,
    };
  }
  async settle(tracked, control) {
    for (;;) {
      let pending = false;
      for (const [id, item] of tracked) {
        if (item.outcome) continue;
        let session;
        try {
          session = await this.services.sessions.get(id);
        } catch (error) {
          if (error.status !== 404) throw error;
          item.outcome = "released";
          continue;
        }
        const state = session.reload?.state;
        const ours = item.wasInFlight || session.reload?.requestId === item.requestId;
        if (inFlight(state)) pending = true;
        else if (ours && state === "completed") item.outcome = "reloaded";
        else if (ours && state === "failed") {
          item.outcome = "failed";
          item.error = session.reload?.error || null;
        } else if (session.status !== "running") item.outcome = "released";
        else {
          item.outcome = "failed";
          item.error = "The reload was cancelled before it completed.";
        }
      }
      if (!pending) return;
      this.checkpoint(control, tracked);
      await sleep(this.pollMs);
    }
  }
  async awaitReferences(version, control, tracked) {
    for (let attempt = 0; ; attempt++) {
      const entry = this.entry(version);
      if (!entry)
        throw migrateError(
          "migrateChanged",
          "The release is no longer available for cleanup.",
        );
      if (entry.canDelete) return;
      // Anything other than canDelete/inUse (active, newer, busy, unsafe) is a changed
      // state, not a lingering process.
      if (entry.deleteReason !== "inUse")
        throw migrateError(
          "migrateChanged",
          "The release is no longer in a state that allows cleanup. Refresh the list.",
        );
      const remaining = [
        ...entry.unidentifiedProcesses,
        ...entry.sessionIds.map((id) => ({ reference: `sessions/${id}` })),
        ...entry.helperProcesses,
      ];
      if (entry.unidentifiedProcesses.length || attempt >= this.settleAttempts)
        throw migrateError(
          "migrateBlocked",
          "Processes still use this release. The release was kept.",
          409,
          { remaining },
        );
      this.checkpoint(control, tracked);
      await sleep(this.pollMs);
    }
  }
  async awaitActivation(marker) {
    const lock = path.join(
      this.operations.config.dataDir,
      "operations/release-activation.lock",
    );
    const deadline = Date.now() + this.activationTimeoutMs;
    while (Date.now() < deadline) {
      let job;
      try {
        job = this.operations.jobs.get(marker.jobId);
      } catch {
        return false;
      }
      if (job.status === "succeeded") {
        if (!fs.existsSync(lock)) return job.result?.activated === true;
      } else if (job.status !== "running") return false;
      if (this.operations.jobs.closed) return false;
      await sleep(this.activationPollMs);
    }
    return false;
  }
  async resumeAfterActivation() {
    let marker = null;
    try {
      marker = readJson(this.marker, null);
    } catch (error) {
      fs.rmSync(this.marker, { force: true });
      this.log(
        `Post-activation marker was unreadable and has been removed: ${error.message}`,
      );
      return;
    }
    if (!marker) return;
    try {
      let verified =
        typeof marker.to === "string" && typeof marker.jobId === "string"
          ? await this.awaitActivation(marker)
          : false;
      // The reload binds sessions to the release this process runs from. Only reload
      // when the active release really is the one the marker asked for.
      if (verified && this.operations.releases.status().current !== marker.to) {
        verified = false;
        this.log(
          `Post-activation reload skipped: the active release is not ${marker.to}.`,
        );
      }
      fs.rmSync(this.marker, { force: true });
      if (!verified) return;
      let count = 0;
      for (const session of await this.services.sessions.list()) {
        if (session.status !== "running") continue;
        try {
          const status = await this.services.reload.status(session.id);
          if (!status.eligible || inFlight(status.state)) continue;
          await this.services.reload.request(session.id, {
            requestId: randomUUID(),
            mode: "when-idle",
          });
          count += 1;
        } catch (error) {
          this.log(
            `Session ${session.id} was not reloaded after activation: ${error.message}`,
          );
        }
      }
      this.operations.audit?.append({
        action: "release.refreshed",
        resourceType: "release",
        resourceId: marker.jobId,
        outcome: "success",
        source: "system",
        details: { version: marker.to, count },
      });
    } catch (error) {
      fs.rmSync(this.marker, { force: true });
      this.log(`Post-activation reload skipped: ${error.message}`);
    }
  }
}
