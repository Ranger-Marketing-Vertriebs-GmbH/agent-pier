import { readJSON, writePrivate } from "../../lib/storage.js";
import { temporaryMember } from "./team-presentation.js";
import { assistantProblem } from "./assistant-validation.js";
import { destroyBackupKeys } from "./backup-credentials.js";

const blockedModel = { primary: "agentpier-unavailable/blocked", fallbacks: [] };
const central = (profile) => !profile.model.connectionId.startsWith("openclaw:");

export class AssistantProviderSynchronization {
  constructor({ assistants, connections, maintenance, isUpdating = () => false }) {
    Object.assign(this, { assistants, connections, maintenance, isUpdating });
    this.blocked = new Set();
    this.changing = false;
  }
  // Called after runtime config preparation, before spawning the owned Gateway.
  // Authored config is updated while stopped; native contract tests verify that
  // the Gateway actually consumes these references after restart.
  async prepare() {
    const a = this.assistants;
    if (a.runtime.client?.ready) throw assistantProblem("active", 409);
    const config = readJSON(a.runtime.paths.config, null);
    if (!config) return;
    const profiles = a.store.listAssistants();
    const entries = config.agents?.entries || config.agents?.list;
    const providers = { ...config.models?.providers };
    for (const key of Object.keys(providers))
      if (profiles.some((profile) => key.startsWith(`ap-${profile.model.connectionId}-`)))
        delete providers[key];
    const blocked = new Set();
    for (const profile of profiles) {
      const entry = Array.isArray(entries)
        ? entries.find((value) => value.id === profile.runtimeAgentId)
        : entries?.[profile.runtimeAgentId];
      if (!entry) continue;
      let lease;
      try {
        if (!central(profile)) {
          const selected = a.models.accounts.offlineSelection(
            profile.model.connectionId,
            profile.model.modelId,
          );
          entry.model = { primary: selected.modelRef, fallbacks: [] };
          if (!selected.available) blocked.add(profile.id);
          continue;
        }
        lease = await a.models.resolve(profile.model);
        if (!lease.provider || !lease.providerId) throw assistantProblem("provider");
        providers[lease.providerId] = lease.provider;
        entry.model = { primary: lease.modelRef, fallbacks: [] };
      } catch {
        entry.model = { ...blockedModel };
        blocked.add(profile.id);
      } finally {
        lease?.release();
      }
    }
    config.models = { ...config.models, providers };
    writePrivate(a.runtime.paths.config, config);
    this.blocked = blocked;
    a.config.reset?.();
  }
  async pauseBlocked({ duringMaintenance = false } = {}) {
    const a = this.assistants;
    if (!a.runtime.client?.ready || (a.maintenance && !duringMaintenance)) return;
    try {
      for (const id of this.blocked) {
        if (!a.store.getAssistant(id).archivedAt) await a.reminders?.disable(id);
      }
    } catch (error) {
      // A lost cron acknowledgement must not leave scheduling with uncertain
      // authorization. The next start repeats the offline model guard.
      await a.runtime.stop();
      throw error;
    }
  }
  /** True when changing this connection must restart the Gateway of its agents. */
  affects(connectionId) {
    return this.assistants.store
      .listAssistants()
      .some((profile) => profile.model.connectionId === connectionId);
  }
  /** Agents the owner knows by name, plus a count of temporary team members. */
  usage(connectionId) {
    const using = this.assistants.store
      .listAssistants()
      .filter((profile) => profile.model.connectionId === connectionId);
    return {
      agents: using
        .filter((p) => !temporaryMember(p))
        .map(({ id, name }) => ({ id, name })),
      teamMembers: using.filter(temporaryMember).length,
    };
  }
  /**
   * `confirmed` records the owner's consent to restart the Gateway. It is checked
   * here, together with the usage it depends on, so no agent can start using the
   * connection between a separate check and the change.
   */
  async change(connectionId, operation, { online = false, confirmed = false } = {}) {
    const a = this.assistants;
    // Provider keys and account profiles are sealed in update backups. A changed or
    // revoked credential makes every existing backup key worthless first.
    const revokeBackups = () => {
      if (a.runtime.paths?.root) destroyBackupKeys(a.runtime.paths.root);
    };
    if (!online && !this.affects(connectionId)) {
      revokeBackups();
      return operation();
    }
    if (!online && !confirmed)
      throw Object.assign(assistantProblem("restartRequired", 409), {
        code: "ASSISTANT_RESTART_REQUIRED",
        affected: this.usage(connectionId),
      });
    if (this.changing || a.maintenance || this.isUpdating())
      throw assistantProblem("active", 409);
    if (!this.maintenance) throw assistantProblem("unavailable", 503);
    this.changing = true;
    let safeToLeave = false;
    try {
      await this.maintenance.enter();
      if ((await this.maintenance.blockers()).length) {
        safeToLeave = true;
        throw assistantProblem("active", 409);
      }
      revokeBackups();
      const wasRunning = a.runtime.status().availability !== "disabled";
      if (!online) {
        await a.runtime.stop();
        await this.maintenance.quiesce();
      } else {
        // Native logout rewrites model references. Disable dependent jobs before
        // that RPC, while the global cron/admission gate is already closed.
        for (const profile of a.store.listAssistants())
          if (profile.model.connectionId === connectionId && !profile.archivedAt)
            await a.reminders?.disable(profile.id);
      }
      let result, failure;
      try {
        result = await operation();
      } catch (error) {
        failure = error;
      }
      if (online) {
        await a.runtime.stop();
        await this.maintenance.quiesce();
      }
      await this.prepare();
      if (online && failure) throw assistantProblem("unavailable", 503);
      if (wasRunning) await a.runtime.start();
      await this.pauseBlocked({ duringMaintenance: true });
      safeToLeave = true;
      a.changed();
      if (failure) throw failure;
      return result;
    } catch (error) {
      // Config parsing and native RPC errors may contain private configuration.
      // Only the completed mutation's validation error or our own busy guard is
      // safe to return through the public provider route.
      if (safeToLeave) throw error;
      throw assistantProblem("unavailable", 503);
    } finally {
      try {
        if (safeToLeave) await this.maintenance.leave();
      } catch {
        throw assistantProblem("unavailable", 503);
      } finally {
        this.changing = false;
      }
    }
  }
}
