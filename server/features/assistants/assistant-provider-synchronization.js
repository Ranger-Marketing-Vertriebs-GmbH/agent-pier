import { readJSON, writePrivate } from "../../lib/storage.js";
import { temporaryMember } from "./team-presentation.js";
import { assistantProblem } from "./assistant-validation.js";
import { destroyBackupKeys } from "./backup-credentials.js";
import { personalCapabilities } from "./native-capabilities.js";

const blockedModel = { primary: "agentpier-unavailable/blocked", fallbacks: [] };
const central = (profile) => !profile.model.connectionId.startsWith("openclaw:");
// Work even the owner's "Restart now" waits for: a sign-in in progress and a workflow
// executing approved actions.
const unforceable = ["ACCOUNT_LOGIN", "WORKFLOW_WORK"];
/** The owner must confirm a Gateway restart; `affected` names who it interrupts. */
export const restartRequired = (key, affected) =>
  Object.assign(assistantProblem(key, 409), {
    code: "ASSISTANT_RESTART_REQUIRED",
    affected,
  });

export class AssistantProviderSynchronization {
  // `pdfModel()` is the owner's PDF model selection, or null (pdf-model-settings.js).
  constructor({
    assistants,
    connections,
    maintenance,
    isUpdating = () => false,
    pdfModel = () => null,
  }) {
    Object.assign(this, { assistants, connections, maintenance, isUpdating, pdfModel });
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
    const pdf = this.pdfModel();
    const connectionIds = [
      ...profiles.map((profile) => profile.model.connectionId),
      ...(pdf ? [pdf.connectionId] : []),
    ];
    for (const key of Object.keys(providers))
      if (connectionIds.some((id) => key.startsWith(`ap-${id}-`))) delete providers[key];
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
    await this.preparePdf(config, providers, pdf);
    config.models = { ...config.models, providers };
    writePrivate(a.runtime.paths.config, config);
    this.blocked = blocked;
    a.config.reset?.();
  }
  /**
   * The PDF model of a start that offers `pdf` (web-tools.js compiled the tool for an
   * agent that reads PDFs): its reference and, for a model connection, its provider.
   * Without a usable model the tool is withdrawn, so no agent is offered a tool that
   * would pick some other model on its own.
   */
  async preparePdf(config, providers, pdf) {
    const offered =
      Array.isArray(config.tools?.allow) && config.tools.allow.includes("pdf");
    if (!offered) return;
    let primary = null;
    let lease;
    try {
      if (pdf && !central({ model: pdf })) {
        const selected = this.assistants.models.accounts.offlineSelection(
          pdf.connectionId,
          pdf.modelId,
        );
        if (selected.available) primary = selected.modelRef;
      } else if (pdf) {
        lease = await this.assistants.models.resolve(pdf);
        if (lease.provider && lease.providerId) {
          providers[lease.providerId] = lease.provider;
          primary = lease.modelRef;
        }
      }
    } catch {
      primary = null;
    } finally {
      lease?.release();
    }
    if (primary) {
      config.agents = {
        ...config.agents,
        defaults: { ...config.agents?.defaults, pdfModel: { primary, fallbacks: [] } },
      };
      return;
    }
    config.tools.allow = config.tools.allow.filter((tool) => tool !== "pdf");
    const entries = config.agents?.entries || config.agents?.list || {};
    for (const entry of Object.values(entries))
      if (Array.isArray(entry?.tools?.allow))
        entry.tools.allow = entry.tools.allow.filter((tool) => tool !== "pdf");
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
  /** Whether `profile` runs on the connection: its model, or the PDF model it reads with. */
  uses(profile, connectionId, pdf = this.pdfModel()) {
    return (
      profile.model.connectionId === connectionId ||
      (pdf?.connectionId === connectionId && personalCapabilities(profile).readPdfs)
    );
  }
  /** True when changing this connection must restart the Gateway of its agents. */
  affects(connectionId) {
    const pdf = this.pdfModel();
    return this.assistants.store
      .listAssistants()
      .some((profile) => this.uses(profile, connectionId, pdf));
  }
  /** Agents the owner knows by name, plus a count of temporary team members. */
  usage(connectionId) {
    const pdf = this.pdfModel();
    const using = this.assistants.store
      .listAssistants()
      .filter((profile) => this.uses(profile, connectionId, pdf));
    return {
      agents: using
        .filter((p) => !temporaryMember(p))
        .map(({ id, name }) => ({ id, name })),
      teamMembers: using.filter(temporaryMember).length,
    };
  }
  /**
   * Changes a connection. One that agents use needs a Gateway restart: in the app the
   * change is saved at once and the restart is left to `pending` (pending-restart.js),
   * which runs it as soon as nothing is busy. Without one (tools, tests), `confirmed`
   * records the owner's consent to an immediate restart, checked here together with
   * the usage it depends on. A native logout (`online`) always restarts at once.
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
    if (!online && this.pending) {
      // The running Gateway keeps the previous credential until the restart.
      const usage = this.usage(connectionId);
      revokeBackups();
      const result = await operation();
      this.pending.request("connection", usage);
      return result;
    }
    if (!online && !confirmed)
      throw restartRequired("restartRequired", this.usage(connectionId));
    return this.restartGateway(operation, {
      online,
      beforeChange: revokeBackups,
      // Native logout rewrites model references. Disable dependent jobs before
      // that RPC, while the global cron/admission gate is already closed.
      dependent: (profile) => profile.model.connectionId === connectionId,
    });
  }
  /**
   * Runs `operation` in maintenance and restarts the Gateway, so the next start
   * compiles its result. Offline, the Gateway is stopped before the operation;
   * `online` runs it against the live Gateway (after disabling the jobs of
   * `dependent` profiles) and stops afterwards. Busy work refuses with 409 first
   * (its `blockers` name it); `force` (the owner's "Restart now") interrupts agent
   * work, never an account sign-in or a workflow that is executing.
   */
  async restartGateway(
    operation,
    {
      online = false,
      beforeChange = () => {},
      dependent = () => false,
      force = false,
    } = {},
  ) {
    const a = this.assistants;
    if (this.changing || a.maintenance || this.isUpdating())
      throw assistantProblem("active", 409);
    if (!this.maintenance) throw assistantProblem("unavailable", 503);
    this.changing = true;
    let safeToLeave = false;
    try {
      await this.maintenance.enter();
      const blockers = (await this.maintenance.blockers()).filter(
        (code) => !force || unforceable.includes(code),
      );
      if (blockers.length) {
        safeToLeave = true;
        throw Object.assign(assistantProblem("active", 409), { blockers });
      }
      // Awaited while the Gateway still runs, after nothing can refuse the change.
      await beforeChange();
      const wasRunning = a.runtime.status().availability !== "disabled";
      if (!online) {
        await a.runtime.stop();
        await this.maintenance.quiesce();
      } else {
        for (const profile of a.store.listAssistants())
          if (dependent(profile) && !profile.archivedAt)
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
