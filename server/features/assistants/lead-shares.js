import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { personalCapabilities, personalEligible } from "./native-capabilities.js";
import { projectFileLevels } from "./member-grants.js";
import { requestTerminal } from "./lead-request-store.js";
import { shareNote } from "./lead-share-input.js";

const rank = (level) => projectFileLevels.indexOf(level);
const lower = (a, b) => (rank(a) < 0 || rank(b) < 0 ? null : rank(a) < rank(b) ? a : b);
const higher = (a, b) => (rank(a) >= rank(b) ? a : b);
// Coding requests that still wait for the owner or run on the share they rest on.
const openCoding = new Set(["awaiting_approval", "approved", "executing", "running"]);

/**
 * What a lead shares of its own access with one of its permanent members
 * (AGENTPIER-153): project folders (read or write), coding projects (coding
 * requests on the lead's project and pipelines, each approved by the owner), the
 * MCP servers bound to the lead and, standing only, Read images (`capability`,
 * lead-capability-shares.js, resolved into the member's capabilities on every read). Kept apart from the member's own access
 * (assistant_access), one row per member, lead, resource and scope: standing
 * (`requestId` null) or for one delegated task (`requestId`). A share is only an
 * upper bound: it counts while lead and member stay what they are (the lead active,
 * the member its permanent, unarchived member) and never above what the lead holds
 * at that moment, read live on every use. `prune` removes shares that ended for good
 * (lead or member archived, the lead lost the project or server, the task ended),
 * the owner removes any one. Every grant, revocation and use is audited.
 */
export class LeadShares {
  constructor(workflows) {
    this.w = workflows;
    this.db = workflows.a.store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_lead_shares(id TEXT PRIMARY KEY,member_assistant_id TEXT NOT NULL,lead_id TEXT NOT NULL,body TEXT NOT NULL)",
    );
  }
  get teams() {
    return this.w.a.teams?.store || null;
  }
  get servers() {
    return this.w.a.mcp?.servers || null;
  }
  rows(memberAssistantId) {
    const rows = memberAssistantId
      ? this.db
          .prepare(
            "SELECT body FROM assistant_lead_shares WHERE member_assistant_id=? ORDER BY rowid",
          )
          .all(memberAssistantId)
      : this.db.prepare("SELECT body FROM assistant_lead_shares ORDER BY rowid").all();
    return rows.map((r) => JSON.parse(r.body));
  }
  find(id) {
    const row = this.db
      .prepare("SELECT body FROM assistant_lead_shares WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  write(row) {
    this.db
      .prepare(
        "INSERT INTO assistant_lead_shares VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(row.id, row.memberAssistantId, row.leadId, JSON.stringify(row));
    return row;
  }
  delete(id) {
    this.db.prepare("DELETE FROM assistant_lead_shares WHERE id=?").run(id);
  }
  // --- live state -------------------------------------------------------------
  /**
   * Why a share counts for nothing right now, or null while lead, member and (for
   * one task) the task are what they were when it was granted. Never throws.
   */
  ended(row) {
    const store = this.w.a.store;
    let lead, member;
    try {
      lead = store.getAssistant(row.leadId);
    } catch {
      return "lead-gone";
    }
    if (lead.archivedAt) return "lead-archived";
    if (!personalEligible(lead) || lead.teamMemberId) return "lead-gone";
    try {
      member = store.getAssistant(row.memberAssistantId);
    } catch {
      return "member-gone";
    }
    if (member.archivedAt) return "member-archived";
    const record = this.teams?.find(row.memberId);
    if (
      member.teamMemberId !== row.memberId ||
      member.lifetime !== "permanent" ||
      !record ||
      record.kind !== "member" ||
      record.parentAssistantId !== row.leadId ||
      record.lifetime !== "permanent"
    )
      return "member-left";
    if (record.archivedAt) return "member-archived";
    if (row.requestId) {
      const r = this.teams?.find(row.requestId);
      if (
        !r ||
        r.kind !== "lead-request" ||
        r.memberAssistantId !== row.memberAssistantId ||
        requestTerminal.has(r.phase)
      )
        return "task-ended";
    }
    return null;
  }
  /** The lead's own access row, or null when it cannot be read. */
  leadPolicy(leadId) {
    try {
      return this.w.access.get(leadId);
    } catch {
      return null;
    }
  }
  // Whether the lead is bound to the server now: true, false or null (unreadable).
  leadBound(row) {
    try {
      const servers = this.servers;
      if (!servers) return null;
      if (!servers.bindings("agent", row.leadId).includes(row.serverId)) return false;
      // An agent with its own Telegram bot for other people never runs a host command.
      if (
        this.w.a.mcp?.telegramSenders?.connected(row.memberAssistantId) &&
        servers.get(row.serverId)?.transport === "stdio"
      )
        return false;
      return true;
    } catch {
      return null;
    }
  }
  /**
   * The share as it applies now: `coding` and `folder` within the lead's own grant
   * of the project, `bound` while the lead holds the server; nothing once ended.
   */
  live(row) {
    const ended = this.ended(row);
    if (row.kind === "capability") {
      if (ended) return { ended, on: false, unknown: false };
      try {
        const lead = this.w.a.store.getAssistant(row.leadId);
        return { ended, on: personalCapabilities(lead)[row.capability] === true };
      } catch {
        return { ended, on: false, unknown: true };
      }
    }
    if (row.kind === "mcp") {
      const bound = ended ? false : this.leadBound(row);
      return { ended, bound: bound === true, unknown: bound === null };
    }
    const policy = ended ? null : this.leadPolicy(row.leadId);
    const holds = !!policy?.projectIds.includes(row.projectId);
    return {
      ended,
      coding: !!row.coding && holds,
      folder: holds ? lower(row.folder, policy.projectFiles?.[row.projectId]) : null,
      unknown: !ended && !policy,
    };
  }
  /** Rows of a member that apply in a scope: standing ones, and one task's own. */
  scoped(memberAssistantId, { requestId = null } = {}) {
    return this.rows(memberAssistantId).filter(
      (row) => !row.requestId || (requestId && row.requestId === requestId),
    );
  }
  /** The member's shared folder levels in a scope, `{ projectId: level }`. */
  folders(memberAssistantId, scope) {
    const out = {};
    for (const row of this.scoped(memberAssistantId, scope)) {
      if (row.kind !== "project") continue;
      const { folder } = this.live(row);
      if (folder)
        out[row.projectId] = out[row.projectId]
          ? higher(out[row.projectId], folder)
          : folder;
    }
    return out;
  }
  /**
   * The share a coding request on `projectId` rests on in a scope: a task's own share
   * first, then a standing one; null without a live one.
   */
  coding(memberAssistantId, projectId, scope) {
    const rows = this.scoped(memberAssistantId, scope).filter(
      (row) => row.kind === "project" && row.projectId === projectId,
    );
    rows.sort((a, b) => (b.requestId ? 1 : 0) - (a.requestId ? 1 : 0));
    const row = rows.find((r) => this.live(r).coding);
    return row ? { leadId: row.leadId, requestId: row.requestId, shareId: row.id } : null;
  }
  /** Projects shared with coding in a scope, with their lead. */
  codingProjects(memberAssistantId, scope) {
    return this.scoped(memberAssistantId, scope).flatMap((row) =>
      row.kind === "project" && this.live(row).coding
        ? [{ projectId: row.projectId, leadId: row.leadId }]
        : [],
    );
  }
  /**
   * Authorizes an inherited coding request (`inherited`: { leadId, requestId,
   * shareId }) on the lead's grant: the share must still give coding, or, for one
   * task's share, have ended only with its task (the owner approves later); the
   * lead must hold project and pipeline as `access.authorize` checks them.
   */
  authorize(memberAssistantId, projectId, pipelineId, revision, inherited) {
    if (!inherited?.leadId) throw assistantProblem("invalid", 403);
    const row = inherited.shareId ? this.find(inherited.shareId) : null;
    const live = row ? this.live(row) : null;
    const valid =
      row &&
      row.memberAssistantId === memberAssistantId &&
      row.leadId === inherited.leadId &&
      row.projectId === projectId &&
      (live.coding ||
        (row.requestId && live.ended === "task-ended" && this.taskDone(row)));
    if (!valid) throw assistantProblem("invalid", 403);
    return this.w.access.authorize(inherited.leadId, projectId, pipelineId, revision);
  }
  // A task that ended on its own (not cancelled), with lead and member unchanged.
  taskDone(row) {
    const r = this.teams?.find(row.requestId);
    if (!r || r.phase === "cancelled") return false;
    const probe = this.ended({ ...row, requestId: null });
    return (
      !probe &&
      !!row.coding &&
      !!this.leadPolicy(row.leadId)?.projectIds.includes(row.projectId)
    );
  }
  /**
   * The run grant of an inherited coding request: the lead's project access for
   * this one project, under the member's own client id so the member reaches only
   * runs it requested; never publishing.
   */
  grant(memberAssistantId, leadId, projectId) {
    const g = this.w.access.grant(leadId);
    return {
      ...g,
      projectIds: [projectId],
      publish: false,
      id: `assistant-${memberAssistantId}`,
      clientId: `assistant-${memberAssistantId}`,
      scopes: g.scopes.filter((s) => s !== "runs:publish"),
    };
  }
  /**
   * `{ [memberAssistantId]: serverId[] }` of servers the members use through their
   * lead now: compiled beside the owner's own bindings (readMcpInputs). Never throws.
   */
  mcpBindings() {
    const out = {};
    try {
      for (const row of this.rows()) {
        if (row.kind !== "mcp" || !this.live(row).bound) continue;
        const list = (out[row.memberAssistantId] ||= []);
        if (!list.includes(row.serverId)) list.push(row.serverId);
      }
    } catch {
      return {};
    }
    return out;
  }
  // --- changes ----------------------------------------------------------------
  /**
   * Applies a lead's share or revocation (lead-share-input.js shareInput, already
   * checked against the lead) for a member, standing or for `requestId`; returns
   * the rows that changed.
   */
  apply({ lead, member, change, revoke = false, requestId = null, inv = null }) {
    const now = new Date().toISOString();
    const key = (kind, resource) =>
      this.rows(member.assistantId).find(
        (r) =>
          r.leadId === lead.id &&
          r.kind === kind &&
          (r.projectId || r.serverId || r.capability) === resource &&
          (r.requestId || null) === requestId,
      );
    const projects = new Set([...Object.keys(change.projects), ...change.coding]);
    const changed = [];
    for (const projectId of [...projects].sort()) {
      const old = key("project", projectId);
      const folder = change.projects[projectId];
      const coding = change.coding.includes(projectId);
      if (revoke) {
        if (!old) continue;
        const next = {
          ...old,
          coding: coding ? false : old.coding,
          folder: folder ? null : old.folder,
        };
        // What this revocation took back, for the chat notes.
        const revoked = [
          ...(folder && old.folder ? ["projects"] : []),
          ...(coding && old.coding ? ["coding"] : []),
        ];
        if (!revoked.length) continue;
        if (!next.coding && !next.folder) this.delete(old.id);
        else this.write(next);
        changed.push({ ...next, removed: !next.coding && !next.folder, revoked });
        continue;
      }
      const row = this.write({
        ...(old || {
          id: randomUUID(),
          kind: "project",
          leadId: lead.id,
          memberId: member.id,
          memberAssistantId: member.assistantId,
          projectId,
          requestId,
          coding: false,
          folder: null,
        }),
        coding: coding || !!old?.coding,
        folder: folder
          ? old?.folder
            ? higher(old.folder, folder)
            : folder
          : old?.folder || null,
        grantedAt: now,
        grantedBy: "lead",
        ...(inv?.attemptId ? { attemptId: inv.attemptId } : {}),
      });
      changed.push(row);
    }
    for (const serverId of change.serverIds) {
      const old = key("mcp", serverId);
      if (revoke) {
        if (old) {
          this.delete(old.id);
          changed.push({ ...old, removed: true });
        }
        continue;
      }
      changed.push(
        this.write({
          ...(old || {
            id: randomUUID(),
            kind: "mcp",
            leadId: lead.id,
            memberId: member.id,
            memberAssistantId: member.assistantId,
            serverId,
            requestId,
          }),
          grantedAt: now,
          grantedBy: "lead",
          ...(inv?.attemptId ? { attemptId: inv.attemptId } : {}),
        }),
      );
    }
    // Read images is only ever shared for good, never with one task.
    for (const capability of requestId ? [] : change.capabilities || []) {
      const old = key("capability", capability);
      if (revoke) {
        if (old) {
          this.delete(old.id);
          changed.push({ ...old, removed: true, revoked: [capability] });
        }
        continue;
      }
      changed.push(
        this.write({
          ...(old || {
            id: randomUUID(),
            kind: "capability",
            leadId: lead.id,
            memberId: member.id,
            memberAssistantId: member.assistantId,
            capability,
            requestId: null,
          }),
          grantedAt: now,
          grantedBy: "lead",
          ...(inv?.attemptId ? { attemptId: inv.attemptId } : {}),
        }),
      );
    }
    if (changed.length) {
      this.audit(changed, { change: revoke ? "revoke" : "grant", by: "lead", requestId });
      this.changed(member.assistantId, changed);
    }
    return changed;
  }
  /** The owner removes one share; open coding requests resting on it fail closed. */
  remove(id) {
    const row = this.find(id);
    if (!row) throw assistantProblem("notFound", 404);
    this.delete(id);
    for (const a of this.w.store.list(row.memberAssistantId))
      if (
        a.inherited?.shareId === id &&
        ["awaiting_approval", "approved"].includes(a.state)
      )
        this.w.store.patch(a.id, { state: "failed", diagnostic: "GRANT_REVOKED" });
    this.audit([{ ...row, removed: true }], { change: "revoke", by: "owner" });
    this.note(row, "revoke", "owner");
    this.changed(row.memberAssistantId, [row]);
    return { removed: id };
  }
  /**
   * Removes the shares that ended for good: lead or member archived or gone, the
   * member no longer the lead's permanent member, the task over, or the lead no
   * longer holding the project or server at all. A lowered level only caps a share
   * (live). Unreadable state removes nothing. Returns whether an MCP share went.
   */
  prune() {
    let mcp = false;
    const members = new Map();
    for (const row of this.rows()) {
      const live = this.live(row);
      if (live.unknown) continue;
      const reason =
        live.ended ||
        (row.kind === "mcp"
          ? !live.bound && "lead-lost"
          : row.kind === "capability"
            ? !live.on && "lead-lost"
            : !live.coding && !live.folder && "lead-lost");
      if (!reason) continue;
      // A coding request on a task's own share stays approvable once the task ended
      // on its own (authorize): the row goes when no open request rests on it.
      if (reason === "task-ended" && this.restsOn(row)) continue;
      this.delete(row.id);
      if (row.kind === "mcp") mcp = true;
      (
        members.get(row.memberAssistantId) ||
        members.set(row.memberAssistantId, []).get(row.memberAssistantId)
      ).push({ ...row, removed: true, reason });
    }
    for (const [memberAssistantId, rows] of members) {
      for (const reason of new Set(rows.map((r) => r.reason)))
        this.audit(
          rows.filter((r) => r.reason === reason),
          { change: "revoke", by: "system", reason },
        );
      // A capability share that went changes what the member compiles (Read images),
      // whoever pruned it: the member is re-applied now (lead-capability-shares.js).
      this.changed(memberAssistantId, rows, {
        quiet: !rows.some((r) => r.kind === "capability"),
      });
    }
    return mcp;
  }
  /** Whether an open coding request of the member rests on this project share. */
  restsOn(row) {
    return (
      row.kind === "project" &&
      !!row.coding &&
      this.w.store
        .list(row.memberAssistantId)
        .some((a) => a.inherited?.shareId === row.id && openCoding.has(a.state))
    );
  }
  // A change reaches the member: MCP servers with the next apply, its instructions
  // (project folders) with its next profile apply.
  changed(memberAssistantId, rows, { quiet = false } = {}) {
    const a = this.w.a;
    if (rows.some((r) => r.kind === "mcp") && a.mcp) a.mcp.pending = true;
    if (!quiet && a.runtime?.client?.ready)
      Promise.resolve()
        .then(() => a.admit(() => a.config.apply(memberAssistantId)))
        .catch(() => {});
    a.changed?.();
  }
  /** One record per change: ids, kinds and levels, never names or content. */
  audit(rows, { change, by, requestId = null, reason = null }) {
    const first = rows[0];
    try {
      this.w.s.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: first.memberAssistantId,
        source: by === "owner" ? "user" : "system",
        outcome: "success",
        details: {
          kind: "lead-share",
          change,
          by,
          leadAssistantId: first.leadId,
          memberId: first.memberId,
          ...((requestId || first.requestId) && {
            requestId: requestId || first.requestId,
          }),
          ...(reason && { reason }),
          projects: rows
            .filter((r) => r.kind === "project")
            .map((r) => ({
              projectId: r.projectId,
              coding: !!r.coding,
              folder: r.folder || "none",
              ...(r.removed && { removed: true }),
            })),
          mcpServerIds: rows.filter((r) => r.kind === "mcp").map((r) => r.serverId),
          capabilities: rows
            .filter((r) => r.kind === "capability")
            .map((r) => r.capability),
        },
      });
    } catch (error) {
      console.error("Lead share audit failed:", error?.message);
    }
  }
  // The owner's removal, noted in the member's chat like a lead's grant change.
  note(row, change, by) {
    try {
      const member = this.teams?.find(row.memberId);
      const lead = this.w.a.store.getAssistant(row.leadId);
      if (member) shareNote(this.w, { lead, member, rows: [row], change, by });
    } catch {
      /* A note is a courtesy; the audit holds the record. */
    }
  }
  // --- owner views --------------------------------------------------------------
  /**
   * Shares as the owner sees them, with names and what applies now; `filter` keeps
   * a member's, a project's or a server's. Ended ones are pruned first.
   */
  list(filter = () => true) {
    try {
      if (this.prune() && this.w.a.mcp) this.w.a.mcp.pending = true;
    } catch {
      /* Listed as they are. */
    }
    const store = this.w.a.store;
    const name = (id) => {
      try {
        return store.getAssistant(id).name;
      } catch {
        return null;
      }
    };
    const projectName = (id) => {
      try {
        return this.w.s.memory.project(id).name;
      } catch {
        return null;
      }
    };
    const serverName = (id) => {
      try {
        return this.servers?.get(id)?.name ?? null;
      } catch {
        return null;
      }
    };
    return this.rows()
      .filter(filter)
      .map((row) => {
        const live = this.live(row);
        return {
          id: row.id,
          kind: row.kind,
          leadId: row.leadId,
          leadName: name(row.leadId),
          memberAssistantId: row.memberAssistantId,
          memberName: name(row.memberAssistantId),
          requestId: row.requestId || null,
          grantedAt: row.grantedAt,
          ...(row.kind === "capability"
            ? { capability: row.capability, live: { on: live.on === true } }
            : row.kind === "project"
              ? {
                  projectId: row.projectId,
                  projectName: projectName(row.projectId),
                  coding: !!row.coding,
                  folder: row.folder || "none",
                  live: { coding: live.coding, folder: live.folder || "none" },
                }
              : {
                  serverId: row.serverId,
                  serverName: serverName(row.serverId),
                  live: { bound: live.bound },
                }),
        };
      });
  }
}
