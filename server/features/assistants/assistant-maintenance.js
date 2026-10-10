import { assistantProblem } from "./assistant-validation.js";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJSON } from "../../lib/storage.js";
import { durablePrivate } from "./runtime-update-snapshot.js";
import { ledgerFence } from "./ledger-fence.js";
export function needsAssistantMaintenance(paths) {
  if (fs.existsSync(path.join(paths.root, "runtime-maintenance.json"))) return true;
  try {
    const update = readJSON(path.join(paths.root, "update.json"), { phase: "idle" });
    return !["idle", "staging", "staged", "complete", "rolled_back"].includes(
      update?.phase,
    );
  } catch {
    return true;
  }
}
export class AssistantMaintenance {
  constructor(services) {
    this.s = services;
  }
  async enter() {
    const a = this.s.assistants;
    if (
      ["installing", "starting", "stopping", "reconnecting"].includes(
        this.s.assistantRuntime.status?.().availability,
      )
    )
      throw assistantProblem("active", 409);
    a.maintenance = true;
    a.maintenanceEpoch = (a.maintenanceEpoch || 0) + 1;
    const paths = this.s.assistantRuntime.paths;
    if (paths) {
      this.file = path.join(paths.root, "runtime-maintenance.json");
      this.intent = readJSON(this.file, null);
      if (!this.intent) {
        this.intent = {
          cronEnabled: readJSON(paths.config, {})?.cron?.enabled === true,
          wasRunning: this.s.assistantRuntime.status?.().availability !== "disabled",
        };
        durablePrivate(this.file, this.intent);
      }
      if (typeof this.intent.cronEnabled !== "boolean")
        throw assistantProblem("unavailable", 503);
    }
    await Promise.allSettled(
      [
        ...a.locks.values(),
        a.reconciling,
        this.s.assistantTeams?.scheduler.running,
        a.workflows?.running,
      ].filter(Boolean),
    );
    if (this.intent && this.s.assistantRuntime.client?.ready) await this.setCron(false);
    await this.s.assistantChannels.pause();
    await this.quiesce();
  }
  async quiesce() {
    const a = this.s.assistants;
    await Promise.allSettled(
      [
        a.reconciling,
        a.workflows?.running,
        this.s.assistantTeams?.scheduler.running,
        ...(this.s.assistantReminders?.webhook.jobs || []),
      ].filter(Boolean),
    );
    await this.s.assistantChannels.queue?.catch(() => {});
  }
  async blockers() {
    const s = this.s,
      a = s.assistants,
      blockers = [];
    if (a.ledger.pending().length) blockers.push("ASSISTANT_WORK");
    if (
      s.assistantTeams?.store
        .members()
        .some((m) => !["completed", "failed", "cancelled"].includes(m.phase)) ||
      s.assistantTeams?.store
        .list()
        .some((t) => ["approved", "queued", "running", "stopping"].includes(t.phase))
    )
      blockers.push("TEAM_WORK");
    if (
      s.assistantChannels.store
        .list()
        .some(
          (c) =>
            s.assistantChannels.ledger.active(c.id).length ||
            s.assistantChannels.outbox.pending(c.id).length,
        )
    )
      blockers.push("CHANNEL_WORK");
    if (["starting", "awaiting_user"].includes(s.assistantModelLogin?.attempt?.status))
      blockers.push("ACCOUNT_LOGIN");
    if (
      a.workflows?.store
        .list()
        .some((x) => ["approved", "executing", "unknown", "running"].includes(x.state))
    )
      blockers.push("WORKFLOW_WORK");
    if (s.assistantRuntime.client?.ready && (await s.assistantReminders?.hasRunning()))
      blockers.push("SCHEDULED_WORK");
    return blockers;
  }
  async validate() {
    const s = this.s,
      client = s.assistantRuntime.client;
    if (!client?.ready) throw assistantProblem("unavailable", 503);
    if (this.intent && (await client.call("cron.status", {})).enabled)
      throw assistantProblem("conflict", 409);
    const roster = await client.call("agents.list", {});
    for (const a of s.assistants.store.listAssistants()) {
      if (a.effectiveRevision && !roster.agents?.some((p) => p.id === a.runtimeAgentId))
        throw assistantProblem("conflict", 409);
    }
    for (const c of s.assistants.store.listConversations())
      await client.call("sessions.describe", { key: c.runtimeSessionKey });
    if ((await this.blockers()).length) throw assistantProblem("active", 409);
  }
  async leave() {
    const paths = this.s.assistantRuntime.paths;
    await this.s.assistantProviderSynchronization?.pauseBlocked({
      duringMaintenance: true,
    });
    if (this.intent && this.s.assistantRuntime.client?.ready)
      await this.setCron(this.intent.cronEnabled);
    if (this.file) {
      fs.rmSync(this.file, { force: true });
      const descriptor = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      this.intent = null;
    }
    // Leaving maintenance always ends an update's ledger fence.
    if (paths) ledgerFence(paths.root).open();
    this.s.assistants.maintenance = false;
    this.s.assistantChannels.resume();
    this.s.assistants.reconcile().catch(() => {});
  }
  recoveryState() {
    if (this.s.assistantProviderSynchronization?.changing) return null;
    const root = this.s.assistantRuntime.paths?.root;
    if (!root) return null;
    try {
      return readJSON(path.join(root, "runtime-maintenance.json"), null);
    } catch {
      return { invalid: true };
    }
  }
  async setCron(enabled) {
    const runtime = this.s.assistantRuntime;
    const previous = await runtime.client.call("config.get", {});
    if (previous.config?.cron?.enabled !== enabled)
      await runtime.client.call("config.patch", {
        baseHash: previous.hash,
        raw: JSON.stringify({ cron: { enabled } }),
      });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (
          runtime.client?.ready &&
          (await runtime.client.call("cron.status", {})).enabled === enabled
        )
          return;
      } catch {
        /* Wait for a hot reload; never reopen admission on uncertain state. */
      }
      await delay(50);
    }
    throw assistantProblem("unavailable", 503);
  }
}
