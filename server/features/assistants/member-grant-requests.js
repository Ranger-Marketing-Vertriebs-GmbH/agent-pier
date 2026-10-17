import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { leadServerIds, memberServerNames } from "./team-mcp.js";
import { notifyAction } from "./assistant-action-notifications.js";
import { pairedTelegram } from "./team-coding.js";
import {
  assertWithinLead,
  defaultGrants,
  grantInput,
  grantedKeys,
  mergeGrants,
  removeGrants,
  splitGrants,
} from "./member-grants.js";

const ended = new Set(["completed", "failed", "cancelled", "declined"]);
const terminal = new Set(["completed", "failed", "cancelled", "declined", "expired"]);
// The newest grant changes a member's record keeps; the audit keeps every one.
const kept = 50;

/**
 * A lead's later grants to its running task-bound members (agentpier_team_grant).
 * Within the lead's own ceiling, capabilities, skills and MCP servers apply at once,
 * without the owner, but visibly: the member's record keeps a log the team card and
 * the member's Capabilities tab show, both chats get a note, and the audit records
 * which kinds changed (never names or content). Shell and SSH always wait for the
 * owner's approval, as an action card in the lead's chat and its paired Telegram
 * chat, and apply only once approved. A lead revokes anything at any time.
 */
export class MemberGrants {
  constructor({ teams, assistants, audit = null, onChanged = () => {} }) {
    Object.assign(this, { teams, assistants, audit, onChanged });
  }
  get workflows() {
    return this.assistants.workflows || null;
  }
  // The calling lead's turn and its own running task member.
  turn(inv, memberId) {
    inv.assertCurrent();
    const a = this.assistants,
      attempt = a.ledger.getAttempt(inv.attemptId),
      request = a.ledger.getRequest(attempt.requestId),
      conversation = a.store.getConversation(request.conversationId),
      lead = a.store.getAssistant(conversation.assistantId);
    if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
    let member;
    try {
      member = this.teams.member(memberId);
    } catch {
      throw assistantProblem("teamGrantMemberEnded", 409);
    }
    if (!this.live(member, lead.id)) throw assistantProblem("teamGrantMemberEnded", 409);
    return { attempt, request, conversation, lead, member };
  }
  async grant(inv, input) {
    exact(input, ["memberId", "grants", "mcpServers", "revoke"]);
    if (typeof input.memberId !== "string") throw assistantProblem("invalid");
    if ("revoke" in input && typeof input.revoke !== "boolean")
      throw assistantProblem("invalid");
    const grants = input.grants === undefined ? {} : grantInput(input.grants);
    const servers = memberServerNames(input.mcpServers);
    if (!grantedKeys(grants).length && !servers.length) throw assistantProblem("invalid");
    const turn = this.turn(inv, input.memberId);
    if (input.revoke) return this.revoke(turn, inv, grants, servers);
    const { lead, member } = turn;
    assertWithinLead(lead, grants, {
      shellSsh: this.teams.shellSsh(member.teamId, lead.id),
      ssh: !!this.teams.sshGranted(lead.id),
      projects: this.teams.projectFiles(lead.id),
      github: this.teams.github(lead.id),
    });
    const ids = leadServerIds(this.teams.servers(), lead.id, servers);
    const { own, owner } = splitGrants(grants);
    const pending = grantedKeys(owner);
    // Asked before anything changes, so a refused card leaves the member as it was.
    if (pending.length && !this.workflows) throw assistantProblem("unavailable", 503);
    const granted = grantedKeys(own);
    if (granted.length || ids.length)
      this.apply(turn, inv, { added: own, ids, by: "lead" });
    if (pending.length) this.request(turn, inv, owner);
    this.assistants.changed?.();
    return {
      status: pending.length ? "approval_requested" : "granted",
      memberId: member.id,
      granted,
      mcpServers: ids.length,
      pending,
    };
  }
  revoke(turn, inv, grants, servers) {
    const { member } = turn;
    const byName = new Map(
      (this.teams.servers()?.list() || []).map((s) => [s.name, s.id]),
    );
    const ids = servers.map((name) => byName.get(name)).filter(Boolean);
    this.apply(turn, inv, { removed: grants, ids, by: "lead" });
    // A pending shell or SSH card for what is revoked can no longer be approved.
    if (grants.shell || grants.ssh)
      this.cancelPending(
        turn.lead.id,
        (a) => a.payload.memberId === member.id,
        "REVOKED",
      );
    this.assistants.changed?.();
    return {
      status: "revoked",
      memberId: member.id,
      revoked: grantedKeys(grants),
      mcpServers: ids.length,
    };
  }
  /** Writes the change to the member's record, audits and notes it, then applies it. */
  apply({ lead, member, conversation }, inv, { added, removed, ids = [], by }) {
    const current = this.teams.member(member.id);
    const before = current.grants ?? defaultGrants;
    const grants = removed ? removeGrants(before, removed) : mergeGrants(before, added);
    // Later servers are kept apart from the proposal's, which the owner saw: only
    // those stay with a member kept as a permanent agent (team-mcp.js).
    const proposal = removed
      ? (current.mcpServerIds || []).filter((id) => !ids.includes(id))
      : current.mcpServerIds || [];
    const later = removed
      ? (current.grantedMcpServerIds || []).filter((id) => !ids.includes(id))
      : [...new Set([...(current.grantedMcpServerIds || []), ...ids])].filter(
          (id) => !proposal.includes(id),
        );
    const keys = grantedKeys(removed || added);
    const entry = {
      at: new Date().toISOString(),
      by,
      ...(removed ? { revoked: keys } : { granted: keys }),
      ...(ids.length ? { mcpServers: ids.length } : {}),
    };
    const next = this.teams.write(current, {
      grants,
      mcpServerIds: proposal.length ? proposal : undefined,
      grantedMcpServerIds: later.length ? later : undefined,
      grantLog: [...(current.grantLog || []), entry].slice(-kept),
    });
    this.record(lead, next, entry);
    this.note(lead, next, conversation, inv, entry);
    this.onChanged(next);
    return next;
  }
  record(lead, member, entry) {
    try {
      this.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: member.assistantId,
        source: entry.by === "owner" ? "user" : "system",
        outcome: "success",
        details: {
          kind: "member-grant",
          change: entry.revoked ? "revoke" : "grant",
          grants: entry.revoked || entry.granted,
          teamId: member.teamId,
          leadAssistantId: lead.id,
          count: entry.mcpServers || 0,
        },
      });
    } catch (error) {
      console.error("Member grant audit failed:", error?.message);
    }
  }
  // One settled row per chat: the member's and the lead's (actionNotes).
  note(lead, member, leadConversation, inv, entry) {
    const store = this.workflows?.store;
    if (!store) return;
    const payload = {
      action: "member_grant",
      memberId: member.id,
      memberName: member.name,
      teamId: member.teamId,
      by: entry.by,
      ...(entry.revoked ? { revoked: entry.revoked } : { granted: entry.granted }),
      mcpServers: entry.mcpServers || 0,
    };
    const rows = [
      [member.assistantId, member.conversationId],
      ...(leadConversation ? [[lead.id, leadConversation.id]] : []),
    ];
    const at = Date.now();
    for (const [assistantId, conversationId] of rows) {
      if (!conversationId) continue;
      store.reserve({
        assistantId,
        conversationId,
        attemptId: inv?.attemptId || null,
        origin: { kind: "member-grant" },
        key: `member-grant:${inv?.attemptId || "owner"}:${inv?.toolCallId || at}:${assistantId}`,
        state: "completed",
        payload,
        chatNotes: { result: { at, state: "completed" } },
        settled: true,
      });
    }
  }
  // Shell and SSH: an owner approval in the lead's chat (and its paired Telegram).
  request({ lead, member, request, conversation }, inv, grants) {
    const w = this.workflows;
    const origin = this.teams.context(request.id);
    const telegram = origin.kind === "telegram" ? null : pairedTelegram(w, lead.id);
    const action = w.store.reserve({
      assistantId: lead.id,
      conversationId: conversation.id,
      attemptId: inv.attemptId,
      origin,
      key: `member-grant:${inv.attemptId}:${inv.toolCallId}`,
      state: "awaiting_approval",
      payload: {
        action: "member_grant",
        approval: true,
        memberId: member.id,
        memberName: member.name,
        teamId: member.teamId,
        grants,
      },
      ...(telegram ? { telegram } : {}),
    });
    notifyAction(w, action, "approval");
    return action;
  }
  /** The owner's decision on a shell or SSH grant (AssistantWorkflows.decideOnce). */
  decide(action, decision) {
    const w = this.workflows;
    const done = (state, extra = {}) =>
      w.store.patch(action.id, {
        state,
        ...extra,
        chatNotes: { result: { at: Date.now(), state } },
      });
    if (decision === "decline") {
      const next = done("declined");
      this.assistants.changed?.();
      return next;
    }
    let lead, member;
    try {
      lead = this.assistants.store.getAssistant(action.assistantId);
      member = this.teams.member(action.payload.memberId);
      if (!this.live(member, lead.id))
        throw assistantProblem("teamGrantMemberEnded", 409);
      // The ceiling as it is now: the setting or the lead's own access may have gone.
      assertWithinLead(lead, action.payload.grants, {
        shellSsh: this.teams.shellSsh(member.teamId, lead.id),
        ssh: !!this.teams.sshGranted(lead.id),
      });
    } catch {
      const next = done("failed", { diagnostic: "GRANT_REVOKED" });
      this.assistants.changed?.();
      return next;
    }
    // Noted in the member's chat; the card's own note shows in the lead's.
    this.apply({ lead, member, conversation: null }, null, {
      added: action.payload.grants,
      by: "owner",
    });
    const next = done("completed");
    this.assistants.changed?.();
    return next;
  }
  /**
   * Cancels the lead's waiting shell or SSH cards that `match`, like other
   * cancellations: the chat note now, the Telegram result notice at the next tick
   * (advance), which then settles them.
   */
  cancelPending(leadId, match, diagnostic) {
    const store = this.workflows?.store;
    if (!store) return;
    for (const a of store.list(leadId))
      if (
        a.payload.action === "member_grant" &&
        a.payload.approval &&
        a.state === "awaiting_approval" &&
        match(a)
      )
        store.patch(a.id, {
          state: "cancelled",
          diagnostic,
          chatNotes: { result: { at: Date.now(), state: "cancelled" } },
        });
    this.assistants.changed?.();
  }
  /** The lead's shell and SSH setting went off: none of its cards can be approved. */
  settingOff(leadId) {
    if (this.teams.policy(leadId).memberShellSsh) return;
    this.cancelPending(leadId, () => true, "SETTING_OFF");
  }
  /**
   * Whether a member can still receive a grant: the lead's own task member, not
   * archived or kept as permanent, and either working on its task or finished with
   * a chat its lead can still reach with questions and tasks (lead-requests.js).
   */
  live(member, leadId) {
    return (
      !!member &&
      member.parentAssistantId === leadId &&
      member.lifetime !== "permanent" &&
      !member.archivedAt &&
      (!ended.has(member.phase) || !!member.conversationId)
    );
  }
  /** A member created a reminder on its lead: a note in the lead's chat and an audit. */
  reminderCreated(member) {
    let team;
    try {
      team = this.teams.get(member.teamId);
    } catch {
      return;
    }
    const at = Date.now();
    this.workflows?.store.reserve({
      assistantId: team.parentAssistantId,
      conversationId: team.parentConversationId,
      attemptId: null,
      origin: { kind: "member-grant" },
      key: `member-reminder:${member.id}:${at}:${Math.random()}`,
      state: "completed",
      payload: {
        action: "member_reminder",
        memberId: member.teamMemberId,
        memberName: member.name,
        teamId: member.teamId,
      },
      chatNotes: { result: { at, state: "completed" } },
      settled: true,
    });
    try {
      this.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: team.parentAssistantId,
        source: "system",
        outcome: "success",
        details: {
          kind: "member-reminder",
          teamId: member.teamId,
          requestedBy: member.teamMemberId,
        },
      });
    } catch (error) {
      console.error("Member reminder audit failed:", error?.message);
    }
    this.assistants.changed?.();
  }
  /** The workflows tick: expiry, a member that ended, the notice, then settles. */
  advance(a) {
    const w = this.workflows;
    if (a.state === "awaiting_approval") {
      let member = null;
      try {
        member = this.teams.member(a.payload.memberId);
      } catch {}
      if (!this.live(member, a.assistantId))
        a = w.store.patch(a.id, {
          state: "cancelled",
          diagnostic: "TEAM_ENDED",
          chatNotes: { result: { at: Date.now(), state: "cancelled" } },
        });
      else if (a.expiresAt >= Date.now()) return notifyAction(w, a, "approval");
      else
        a = w.store.patch(a.id, {
          state: "expired",
          chatNotes: { result: { at: Date.now(), state: "expired" } },
        });
    }
    if (terminal.has(a.state)) {
      notifyAction(w, a, "result");
      w.store.patch(a.id, { settled: true });
    }
  }
}
