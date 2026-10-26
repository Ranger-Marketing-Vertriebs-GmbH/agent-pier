import fs from "node:fs";
import path from "node:path";
import { personalEligible } from "../assistants/native-capabilities.js";
import { isUserAgent } from "../users/user-access.js";
import { writeSecretFile } from "./secret-format.js";

const safeId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

/**
 * Delivers each agent's granted secrets (assistant-access.js `secretIds`) as
 * `<workspace>/.agentpier/secrets.env` (secret-format.js) and removes the file once
 * nothing is granted, the agent is no longer eligible or a secret is gone. Every
 * agent syncs after each secret change and each change to the agents (grant saves,
 * archiving, a user agent switch, a bot for other people) and at start; an agent
 * also syncs before each of its turns, so a file it deleted or edited with its
 * shell is back by its next turn. Syncs run one at a time, so an older state never
 * overwrites a newer one.
 */
export class AgentSecrets {
  constructor({ store, access, assistants, workspaces }) {
    Object.assign(this, { store, access, assistants, workspaces });
    this.queue = Promise.resolve();
  }
  file(agentId) {
    return path.join(this.workspaces, agentId, ".agentpier", "secrets.env");
  }
  /**
   * The owner's agents and permanent team members; never a user agent, a temporary
   * member, an archived agent or one with its own bot for other people.
   */
  eligible(agent) {
    return (
      personalEligible(agent) &&
      !isUserAgent(agent) &&
      !this.access.s.assistantTelegramSenders?.connected(agent.id)
    );
  }
  /**
   * The entries the agent's file holds now: none while a hook run without Secrets
   * works (AgentHooks.withholdsSecrets), so the run cannot read them.
   */
  entries(agentId) {
    if (this.assistants.routines?.hooks?.withholdsSecrets(agentId)) return [];
    let agent;
    try {
      agent = this.assistants.store.getAssistant(agentId);
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
    return this.eligible(agent) ? this.store.entries(this.access.secretIds(agentId)) : [];
  }
  /** Resolves "written", "removed" or "unchanged". */
  sync(agentId) {
    const task = this.queue.catch(() => {}).then(() => this.syncOnce(agentId));
    this.queue = task;
    return task;
  }
  async syncOnce(agentId) {
    if (!safeId(agentId)) return "unchanged";
    const entries = this.entries(agentId);
    // A workspace the Gateway has not created yet is left alone; its first turn
    // syncs again. A linked workspace is never written through.
    const workspace = await fs.promises
      .lstat(path.join(this.workspaces, agentId))
      .catch(() => null);
    if (!workspace?.isDirectory()) return "unchanged";
    return writeSecretFile(this.file(agentId), entries);
  }
  /**
   * `syncAll` after the syncs queued now; calls while it waits share it, so a burst
   * of changes costs one pass.
   */
  refresh() {
    this.refreshing ??= this.queue
      .catch(() => {})
      .then(() => {
        this.refreshing = null;
        return this.syncAll();
      });
    return this.refreshing;
  }
  /** Every agent's file; one failing agent never stops the others. */
  async syncAll() {
    let agents = [];
    try {
      agents = this.assistants.store.listAssistants();
    } catch {
      return;
    }
    for (const agent of agents)
      await this.sync(agent.id).catch((error) =>
        console.error("Agent secrets file could not be written:", error?.code || "error"),
      );
  }
}

/**
 * Connects the delivery to a constructed assistant graph: secret changes and agent
 * changes (AssistantService.changed) refresh every file at once, and each turn
 * syncs first and names the file in the bootstrap while it has entries
 * (assistant-config.js). Returns the instance, or null without a
 * secret store; `close()` stops listening.
 */
export function connectAgentSecrets(store, graph) {
  const { assistants, assistantWorkflows, assistantRuntime } = graph;
  if (!store || !assistantWorkflows || !assistantRuntime?.paths?.workspaces) return null;
  const agentSecrets = new AgentSecrets({
    store,
    access: assistantWorkflows.access,
    assistants,
    workspaces: assistantRuntime.paths.workspaces,
  });
  const quietly = (promise) => promise.catch(() => {});
  const refresh = () => quietly(agentSecrets.refresh());
  const unsubscribe = [store.onChange(refresh), assistants.events.subscribe(refresh)];
  assistants.config.syncSecrets = (id) => agentSecrets.sync(id);
  // The bootstrap names the file while the agent receives a secret; it is computed
  // on every apply, which runs before each turn, so a grant change reaches it then.
  assistants.config.secretsGranted = (agent) => {
    try {
      return agentSecrets.entries(agent.id).length > 0;
    } catch {
      return false;
    }
  };
  agentSecrets.close = () => {
    for (const stop of unsubscribe) stop();
    delete assistants.config.syncSecrets;
    delete assistants.config.secretsGranted;
  };
  return agentSecrets;
}
