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
    if (
      member.parentAssistantId !== lead.id ||
      member.lifetime === "permanent" ||
      member.archivedAt ||
      ended.has(member.phase)
    )
      throw assistantProblem("teamGrantMemberEnded", 409);
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
      for (const a of this.workflows?.store.list(turn.lead.id) || [])
        if (
          a.payload.action === "member_grant" &&
          a.payload.memberId === member.id &&
          a.state === "awaiting_approval"
        )
          this.workflows.store.patch(a.id, { state: "cancelled", settled: true });
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
    const servers = removed
      ? (current.mcpServerIds || []).filter((id) => !ids.includes(id))
      : [...new Set([...(current.mcpServerIds || []), ...ids])];
    const keys = grantedKeys(removed || added);
    const entry = {
      at: new Date().toISOString(),
      by,
      ...(removed ? { revoked: keys } : { granted: keys }),
      ...(ids.length ? { mcpServers: ids.length } : {}),
    };
    const next = this.teams.write(current, {
      grants,
      ...(servers.length ? { mcpServerIds: servers } : { mcpServerIds: undefined }),
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
      if (
        member.parentAssistantId !== lead.id ||
        member.lifetime === "permanent" ||
        member.archivedAt ||
        ended.has(member.phase)
      )
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
  /** The workflows tick: expiry and the approval notice, then settles. */
  advance(a) {
    const w = this.workflows;
    if (a.state === "awaiting_approval") {
      if (a.expiresAt >= Date.now()) return notifyAction(w, a, "approval");
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
