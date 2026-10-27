import { assistantProblem } from "./assistant-validation.js";
import { deletionCounts, purgeAgent } from "./agent-deletion.js";

const temporary = (m) => m.lifetime !== "permanent";

/**
 * Archive, restore and permanent delete of any agent (AGENTPIER-260): the owner's
 * own agents, permanent team members and agents of users. A team member goes through
 * its team's archive (team-service.js lifecycle); every other agent gets the same
 * steps here: refused while a turn runs or its own Telegram bot is connected, its
 * routines and check-ins paused, its MCP servers and configuration applied again.
 * Archive keeps all data; only an archived agent can be deleted, which marks it
 * `deleting` first so a start finishes a delete a crash interrupted (resume).
 * Restricted users never reach these routes (route-access.js).
 */
export class AgentLifecycle {
  /** `services`: the assistant graph's scope (assistant-graph.js), or the parts. */
  constructor(services) {
    const s = services;
    this.s = {
      assistants: s.assistants,
      teams: s.teams || s.assistantTeams,
      channels: s.channels || s.assistantChannels,
      mcpServers: s.mcpServers || s.assistantMcpServers,
      paths: s.paths || s.assistantRuntime?.paths,
      dataDir: s.dataDir || s.config?.dataDir,
      audit: s.audit,
    };
  }
  get a() {
    return this.s.assistants;
  }
  get teams() {
    return this.s.teams || this.a.teams;
  }
  /** The stored agent; one being deleted is unknown. */
  agent(id) {
    const agent = this.a.store.storedAssistant(id);
    if (agent.deletingAt) throw assistantProblem("notFound", 404);
    return agent;
  }
  members(leadId) {
    return (this.teams?.store.members() || []).filter(
      (m) => m.parentAssistantId === leadId,
    );
  }
  // Whether a turn of any of `ids` is in flight.
  turnRunning(ids) {
    const set = new Set(ids);
    const { ledger, store } = this.a;
    return ledger.pending().some((attempt) => {
      try {
        const { conversationId } = ledger.getRequest(attempt.requestId);
        return set.has(store.storedConversation(conversationId).assistantId);
      } catch {
        return false;
      }
    });
  }
  audit(action, id, details = {}, source = "user") {
    this.s.audit?.append({
      ...action,
      resourceId: id,
      outcome: "success",
      source,
      details,
    });
  }
  // Archived agents hold no MCP servers and get their entry and check-ins again.
  async reconfigure(ids) {
    await this.teams?.applyMcp?.();
    if (!this.a.runtime?.client?.ready) return;
    for (const id of ids) {
      await this.a.config.apply(id).catch(() => {});
      await this.a.reminders?.heartbeats?.sync(id).catch(() => {});
    }
  }
  /**
   * Archives the agent at `revision`. A lead's unarchived temporary members are
   * archived with it once `members` confirms it; its permanent members stay.
   */
  async archive(id, { revision, members = false } = {}) {
    const agent = this.agent(id);
    if (agent.revision !== revision) throw assistantProblem("conflict", 409);
    if (agent.teamMemberId) {
      const m = this.teams.store.member(id);
      await this.teams.lifecycle("archive", m.id, m.revision);
      this.audit({ action: "assistant.archived", resourceType: "assistant" }, id);
      return this.a.store.getAssistant(id);
    }
    return this.a.admit(async () => {
      const current = this.agent(id);
      if (current.revision !== revision || current.archivedAt)
        throw assistantProblem("conflict", 409);
      // An archived agent must not keep answering people on its own Telegram bot.
      if (this.a.telegramSenders?.connected(id))
        throw assistantProblem("telegramSendersArchive", 409);
      const tasks = this.members(id).filter((m) => temporary(m) && !m.archivedAt);
      if (
        this.turnRunning([id, ...tasks.map((m) => m.assistantId)]) ||
        tasks.some((m) => this.teams.store.activeMember(m))
      )
        throw assistantProblem("active", 409);
      if (tasks.length && !members) throw assistantProblem("leadHasMembers", 409);
      await this.a.reminders?.disable(id);
      for (const m of tasks) this.teams.store.archive(m.id, m.revision);
      const result = this.a.store.setArchived(id, revision, new Date().toISOString());
      await this.reconfigure([id, ...tasks.map((m) => m.assistantId)]);
      await this.a.browsers?.stopAgent?.(id).catch(() => {});
      this.a.changed();
      this.audit(
        { action: "assistant.archived", resourceType: "assistant" },
        id,
        tasks.length ? { memberIds: tasks.map((m) => m.assistantId) } : {},
      );
      return result;
    });
  }
  /** Restores an archived agent at `revision`, unchanged. */
  async restore(id, { revision } = {}) {
    const agent = this.agent(id);
    if (agent.revision !== revision) throw assistantProblem("conflict", 409);
    if (agent.teamMemberId) {
      const m = this.teams.store.member(id);
      await this.teams.lifecycle("restore", m.id, m.revision);
      this.audit({ action: "assistant.restored", resourceType: "assistant" }, id);
      return this.a.store.getAssistant(id);
    }
    return this.a.admit(async () => {
      const current = this.agent(id);
      if (current.revision !== revision || !current.archivedAt)
        throw assistantProblem("conflict", 409);
      const result = this.a.store.setArchived(id, revision, null);
      await this.reconfigure([id]);
      this.a.changed();
      this.audit({ action: "assistant.restored", resourceType: "assistant" }, id);
      return result;
    });
  }
  // The agent and the temporary members deleted with a lead.
  deleted(agent) {
    if (agent.teamMemberId) return [agent];
    const tasks = this.members(agent.id).filter(temporary);
    return [agent, ...tasks.map((m) => this.a.store.storedAssistant(m.assistantId))];
  }
  /** What a delete would remove, as counts for the confirmation. */
  deletion(id) {
    const agent = this.agent(id);
    return {
      id,
      name: agent.name,
      counts: deletionCounts(this.s, this.deleted(agent)),
    };
  }
  /**
   * Deletes an archived agent for good once `name` repeats its name exactly. Refused
   * while a turn of it runs or its configuration is applied, for a lead that still
   * has permanent members, and while the Gateway is not running.
   */
  delete(id, { name } = {}) {
    return this.a.admit(async () => {
      const agent = this.agent(id);
      if (!agent.archivedAt) throw assistantProblem("agentNotArchived", 409);
      if (typeof name !== "string" || name !== agent.name)
        throw assistantProblem("agentDeleteName", 400);
      if (!agent.teamMemberId && this.members(id).some((m) => !temporary(m)))
        throw assistantProblem("agentDeleteMembers", 409);
      const agents = this.deleted(agent);
      const ids = agents.map((a) => a.id);
      if (this.turnRunning(ids) || ids.some((i) => this.a.config.applying?.(i)))
        throw assistantProblem("agentDeleteBusy", 409);
      if (this.a.telegramSenders?.connected(id))
        throw assistantProblem("telegramSendersArchive", 409);
      // The Gateway removes its entry and native jobs (agent-deletion.js).
      if (!this.a.runtime?.client?.ready)
        throw assistantProblem("agentDeleteService", 503);
      this.markDeleting(id);
      await this.finish(this.a.store.storedAssistant(id), "user");
    });
  }
  /** The first step of a delete, on its own: the mark a start resumes from. */
  markDeleting(id) {
    const agent = this.agent(id);
    const agents = this.deleted(agent);
    const counts = deletionCounts(this.s, agents);
    this.a.store.markDeleting(
      agents.map((a) => a.id),
      { leadId: id, counts, memberIds: agents.slice(1).map((a) => a.id) },
    );
    this.a.changed();
  }
  async finish(agent, source) {
    const { leadId, counts, memberIds = [] } = agent.deletion || {};
    for (const memberId of memberIds) {
      let member = null;
      try {
        member = this.a.store.storedAssistant(memberId);
      } catch {
        continue;
      }
      await purgeAgent(this.s, member);
    }
    await purgeAgent(this.s, agent);
    await this.teams?.applyMcp?.();
    await this.a.config?.browserProfiles?.sync?.().catch(() => {});
    this.a.changed();
    if (leadId === agent.id)
      this.audit(
        { action: "assistant.deleted", resourceType: "assistant" },
        agent.id,
        { ...counts, ...(memberIds.length ? { memberIds } : {}) },
        source,
      );
  }
  /** Finishes deletes an earlier process left marked (called once the Gateway runs). */
  resume() {
    return this.a.admit(async () => {
      if (!this.a.runtime?.client?.ready) return;
      for (const agent of this.a.store.deletingAssistants()) {
        let current;
        try {
          current = this.a.store.storedAssistant(agent.id);
        } catch {
          continue;
        }
        // A member goes with its lead; one whose lead is gone goes on its own.
        const leadId = current.deletion?.leadId;
        if (leadId && leadId !== current.id && this.exists(leadId)) continue;
        await this.finish(current, "system");
      }
    });
  }
  exists(id) {
    try {
      this.a.store.storedAssistant(id);
      return true;
    } catch {
      return false;
    }
  }
}
