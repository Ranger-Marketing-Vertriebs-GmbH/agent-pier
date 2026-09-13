import path from "node:path";
import { randomUUID } from "node:crypto";
import { releaseVersion } from "./release-archive.js";
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
    this.log = log;
    this.active = null;
    this.marker = path.join(
      operations.config.dataDir,
      "operations/post-activation-reload.json",
    );
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
    const status = await this.services.reload.status(id);
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
  migrate(version, { interrupt = false } = {}) {
    releaseVersion(version);
    if (typeof interrupt !== "boolean") throw problem("Invalid operation options.");
    if (this.active || this.operations.jobs.running("release-"))
      throw migrateError(
        "migrateBusy",
        "Another release operation is running. Wait for it to finish.",
      );
    const control = { version, cancelled: false };
    this.active = control;
    return this.operations.jobs.start("release-migrate", async (jobId) => {
      try {
        return await this.run(version, interrupt, control, jobId);
      } finally {
        if (this.active === control) this.active = null;
      }
    });
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
      if (inFlight(session.reload)) {
        tracked.set(session.id, { requestId: null, wasInFlight: true });
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
      const remaining = [
        ...entry.unidentifiedProcesses,
        ...entry.sessionIds.map((id) => ({ reference: `sessions/${id}` })),
        ...entry.helperProcesses,
      ];
      if (
        entry.deleteReason !== "inUse" ||
        entry.unidentifiedProcesses.length ||
        attempt >= this.settleAttempts
      )
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
}
