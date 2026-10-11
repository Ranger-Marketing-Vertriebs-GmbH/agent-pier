import { assistantProblem } from "./assistant-validation.js";
import { temporaryMember } from "./team-presentation.js";

export const maxMemberServers = 16;
const ended = new Set(["completed", "failed", "cancelled"]);
const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/** The server names a proposed member asks for; shape only, duplicates dropped. */
export function memberServerNames(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > maxMemberServers ||
    value.some((name) => typeof name !== "string" || !name || name.length > 100)
  )
    throw assistantProblem("invalid");
  return [...new Set(value)];
}

/**
 * Server ids for `names`, each of which must be bound to the lead agent. Any other
 * name (unknown, or another agent's server) rejects the whole proposal.
 */
export function leadServerIds(servers, leadId, names) {
  if (!names.length) return [];
  if (!servers) throw assistantProblem("teamMcpServerNotBound");
  const bound = new Set(servers.bindings("agent", leadId));
  const byName = new Map(
    servers
      .list()
      .filter((s) => bound.has(s.id))
      .map((s) => [s.name, s.id]),
  );
  return names.map((name) => {
    const id = byName.get(name);
    if (!id) throw assistantProblem("teamMcpServerNotBound");
    return id;
  });
}

/** Names and the stdio marker of existing servers; no URLs, commands or secrets. */
export function describeServers(servers, ids) {
  if (!servers || !ids?.length) return [];
  const byId = new Map(servers.list().map((s) => [s.id, s]));
  return ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [{ name: s.name, stdio: s.transport === "stdio" }] : [];
  });
}

/**
 * MCP bindings of team members, derived from the team records. A temporary member
 * holds exactly its approved servers that its lead still holds, and only while it
 * runs; once it ends (or never ran) it holds none. A member approved as permanent
 * receives its servers once and is managed by the owner afterwards. `sync` is
 * idempotent, so every path that ends a member, and every start, converges on it.
 */
export class TeamMcpBindings {
  constructor({ teams, assistants }) {
    Object.assign(this, { teams, assistants });
    this.dirty = false;
  }
  get servers() {
    return this.assistants.mcp?.servers || null;
  }
  /**
   * The servers for an approval, or null when the store cannot be read: callers
   * then show the list as unavailable and refuse approval rather than omit servers.
   */
  describe(ids) {
    try {
      return describeServers(this.servers, ids);
    } catch {
      return null;
    }
  }
  /** Whether every member of a proposal can be shown with its servers. */
  describable(record) {
    const drafts = Array.isArray(record?.members) ? record.members : [];
    return drafts.every((m) => !m.mcpServerIds?.length || this.describe(m.mcpServerIds));
  }
  leadActive(id) {
    try {
      return !this.assistants.store.getAssistant(id).archivedAt;
    } catch {
      return false;
    }
  }
  /** Brings the store in line with the team records; returns whether it changed. */
  sync() {
    const servers = this.servers;
    if (!servers) return false;
    const all = this.teams.members();
    // Members only ever hold servers through their records' approved lists.
    if (!all.some((m) => m.mcpServerIds?.length)) return false;
    let changed = false,
      bound;
    try {
      bound = servers.bindingsByTarget("agent");
    } catch {
      return false;
    }
    for (const m of all)
      try {
        // Ended members without bindings have nothing left to converge.
        if (ended.has(m.phase) && !bound[m.assistantId]?.length) continue;
        const a = this.assistants.store.getAssistant(m.assistantId);
        const live = !ended.has(m.phase) && !a.archivedAt;
        // An archived lead holds no servers for its members.
        const lead = new Set(
          this.leadActive(m.parentAssistantId) ? bound[m.parentAssistantId] || [] : [],
        );
        const approved = (m.mcpServerIds || []).filter((id) => lead.has(id));
        const current = bound[a.id] || [];
        if (temporaryMember(a)) {
          const desired = live ? approved : [];
          if (sameSet(current, desired)) continue;
          servers.setBindings("agent", a.id, desired);
          changed = true;
        } else if (m.mcpServerIds?.length && !m.mcpGranted && live) {
          // Recorded first: a grant is never repeated over the owner's later edits.
          this.teams.write(m, { mcpGranted: true });
          servers.setBindings("agent", a.id, [...new Set([...current, ...approved])]);
          changed = true;
        }
      } catch {
        // A member that cannot be read or written now is retried at the next tick.
      }
    if (changed) this.dirty = true;
    return changed;
  }
  /**
   * Syncs and patches a ready Gateway that compiled MCP servers at its start; any
   * other state compiles the store at the next start. Callers hold the admission
   * lock. A change, or an earlier apply that did not finish, stays pending until an
   * apply succeeds; failures back off (McpChanges.due).
   */
  async refresh() {
    this.sync();
    const mcp = this.assistants.mcp;
    if (!mcp) return;
    if (this.dirty) {
      mcp.pending = true;
      this.dirty = false;
    }
    if (mcp.pending && (mcp.due?.() ?? true)) await mcp.apply();
  }
}
