import { assistantProblem } from "./assistant-validation.js";
import { deletionCounts, purgeAgent } from "./agent-deletion.js";
import { pauseOwnJobs, resumeOwnJobs, settleOwnJobs } from "./agent-own-jobs.js";

const temporary = (m) => m.lifetime !== "permanent";
// A failure as a stable code for the archive list and the log, never a message.
const errorCode = (error) => {
  const code = error?.key ?? error?.code ?? error?.name;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(code)
    ? code
    : "UNKNOWN";
};

/**
 * The owner's list split for agent-lifecycle (assistant-service.js list): agents and
 * chats without those being deleted, and the deletes still pending (with the last
 * failure's code) for Agents › Archive.
 */
export function listedAgents(store) {
  const all = store.listAssistants();
  const gone = new Set(all.filter((a) => a.deletingAt).map((a) => a.id));
  return {
    assistants: all.filter((a) => !gone.has(a.id)),
    conversations: store.listConversations().filter((c) => !gone.has(c.assistantId)),
    deletions: all
      .filter((a) => gone.has(a.id) && (a.deletion?.leadId ?? a.id) === a.id)
      .map((a) => ({ id: a.id, name: a.name, error: a.deletion?.error ?? null })),
  };
}

/**
 * Archive, restore and permanent delete of any agent (AGENTPIER-260): the owner's
 * own agents, permanent team members and agents of users. A team member goes through
 * its team's archive (team-service.js lifecycle); every other agent gets the same
 * steps here: refused while a turn runs or its own Telegram bot is connected, its
 * routines, check-ins and own cron jobs paused, its MCP servers and configuration
 * applied again. Archive keeps all data; only an archived agent can be deleted, which
 * marks it `deleting` first: a failed or interrupted delete stays listed as pending,
 * can be retried and finishes at the next start (resume). Restricted users never
 * reach these routes (route-access.js).
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
      users: s.users,
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
      await this.a.admit(async () =>
        this.a.store.changeUserAgent(id, {
          ownJobs: await pauseOwnJobs(this.a, this.a.store.storedAssistant(id)),
        }),
      );
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
      const ownJobs = await pauseOwnJobs(this.a, current);
      for (const m of tasks) this.teams.store.archive(m.id, m.revision);
      this.a.store.setArchived(id, revision, new Date().toISOString());
      const result = this.a.store.changeUserAgent(id, { ownJobs });
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
  // Whether the user an own agent serves still exists (users/user-store.js).
  userGone(agent) {
    if (agent.userAccess?.mode !== "own" || !this.s.users) return false;
    const userId = agent.userAccess.members?.[0]?.userId;
    try {
      return !userId || !this.s.users.get(userId);
    } catch {
      return true;
    }
  }
  /** Restores an archived agent at `revision`, unchanged. */
  async restore(id, { revision } = {}) {
    const agent = this.agent(id);
    if (agent.revision !== revision) throw assistantProblem("conflict", 409);
    if (agent.teamMemberId) {
      const m = this.teams.store.member(id);
      await this.teams.lifecycle("restore", m.id, m.revision);
      await this.a.admit(async () =>
        this.a.store.changeUserAgent(id, {
          ownJobs: await resumeOwnJobs(this.a, this.a.store.storedAssistant(id)),
        }),
      );
      this.audit({ action: "assistant.restored", resourceType: "assistant" }, id);
      return this.a.store.getAssistant(id);
    }
    return this.a.admit(async () => {
      const current = this.agent(id);
      if (current.revision !== revision || !current.archivedAt)
        throw assistantProblem("conflict", 409);
      // A deleted user's own agent has nobody to serve: it can only be deleted.
      if (this.userGone(current)) throw assistantProblem("userAgentUserGone", 409);
      this.a.store.setArchived(id, revision, null);
      const result = this.a.store.changeUserAgent(id, {
        ownJobs: await resumeOwnJobs(this.a, current),
      });
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
  /** What a delete would remove, as counts for the confirmation; a pending one too. */
  async deletion(id) {
    const agent = this.a.store.storedAssistant(id);
    if (agent.deletingAt)
      return {
        id,
        name: agent.name,
        counts: agent.deletion?.counts || {},
        pending: true,
        error: agent.deletion?.error ?? null,
      };
    return { id, name: agent.name, counts: await this.count(agent) };
  }
  count(agent) {
    return deletionCounts(this.s, this.deleted(agent));
  }
  /**
   * Deletes an archived agent for good once `name` repeats its name exactly, or
   * retries a pending delete. Refused while a turn of it runs or its configuration
   * is applied, for a lead that still has permanent members, and while the Gateway
   * is not running. The counts are read before admission, which never waits on disk.
   */
  async delete(id, { name } = {}) {
    const before = this.a.store.storedAssistant(id);
    const counts = before.deletingAt ? null : await this.count(before);
    return this.a.admit(async () => {
      const agent = this.a.store.storedAssistant(id);
      if (!agent.archivedAt) throw assistantProblem("agentNotArchived", 409);
      if (typeof name !== "string" || name !== agent.name)
        throw assistantProblem("agentDeleteName", 400);
      if (
        !agent.deletingAt &&
        !agent.teamMemberId &&
        this.members(id).some((m) => !temporary(m))
      )
        throw assistantProblem("agentDeleteMembers", 409);
      const ids = agent.deletingAt
        ? [id, ...(agent.deletion?.memberIds || [])]
        : this.deleted(agent).map((a) => a.id);
      if (this.turnRunning(ids) || ids.some((i) => this.a.config.applying?.(i)))
        throw assistantProblem("agentDeleteBusy", 409);
      if (this.a.telegramSenders?.connected(id))
        throw assistantProblem("telegramSendersArchive", 409);
      // The Gateway removes its entry and native jobs (agent-deletion.js).
      if (!this.a.runtime?.client?.ready)
        throw assistantProblem("agentDeleteService", 503);
      if (!agent.deletingAt) this.mark(agent, counts ?? (await this.count(agent)));
      await this.run(this.a.store.storedAssistant(id), "user");
    });
  }
  /** The first step of a delete, on its own: the mark a start resumes from. */
  async markDeleting(id) {
    const agent = this.agent(id);
    this.mark(agent, await this.count(agent));
  }
  mark(agent, counts) {
    const agents = this.deleted(agent);
    const ids = agents.map((a) => a.id);
    // Its Telegram channels, recorded now: a resume after their removal still finds
    // their follow-ups (agent-deletion.js).
    const channelIds = (this.s.channels?.store.list() || [])
      .filter((c) => ids.includes(c.assistantId))
      .map((c) => c.id);
    this.a.store.markDeleting(ids, {
      leadId: agent.id,
      counts,
      memberIds: ids.slice(1),
      channelIds,
    });
    this.a.changed();
  }
  // Runs the purge; a failure stays on the record as a code and is logged.
  async run(agent, source) {
    try {
      await this.finish(agent, source);
    } catch (error) {
      const code = errorCode(error);
      console.warn(`An agent delete did not finish (${code}); it stays pending.`);
      try {
        const current = this.a.store.storedAssistant(agent.id);
        this.a.store.changeUserAgent(agent.id, {
          deletion: {
            ...current.deletion,
            error: code,
            failedAt: new Date().toISOString(),
          },
        });
      } catch {
        /* The record is gone: nothing left to retry. */
      }
      this.a.changed();
      throw error;
    }
  }
  async finish(agent, source) {
    const { leadId, counts, memberIds = [], channelIds = [] } = agent.deletion || {};
    for (const memberId of memberIds) {
      let member = null;
      try {
        member = this.a.store.storedAssistant(memberId);
      } catch {
        continue;
      }
      await purgeAgent(this.s, member, channelIds);
    }
    await purgeAgent(this.s, agent, channelIds);
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
  /**
   * Called once the Gateway runs: finishes the deletes an earlier process left
   * marked, one agent after the other past any that fails, and the pauses and
   * resumes of agents' own jobs that waited for it. Never throws; every failure is
   * logged by its code and a failed delete keeps its code for Agents › Archive.
   */
  resume() {
    return this.a
      .admit(async () => {
        if (!this.a.runtime?.client?.ready) return;
        await settleOwnJobs(this.a).catch((error) =>
          console.warn(`Agents' own jobs were not settled (${errorCode(error)}).`),
        );
        for (const agent of this.a.store.deletingAssistants()) {
          const leadId = agent.deletion?.leadId ?? agent.id;
          // A member goes with its lead; one whose lead is gone goes on its own.
          if (leadId !== agent.id && this.exists(leadId)) continue;
          if (!this.exists(agent.id)) continue;
          await this.run(this.a.store.storedAssistant(agent.id), "system").catch(() => {
            /* Logged and recorded by run(). */
          });
        }
      })
      .catch((error) =>
        console.warn(`Agent deletes could not resume (${errorCode(error)}).`),
      );
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
