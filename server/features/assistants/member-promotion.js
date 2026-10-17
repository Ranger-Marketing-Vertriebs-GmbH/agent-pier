import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { reachableMember } from "./member-reach.js";
import { mirrorLeadMemory } from "./member-memory.js";
import { pairedTelegram } from "./team-coding.js";
import { telegramMessages } from "../assistant-channels/telegram-messages.js";

const kept = 50;

/**
 * A lead keeps one of its own task members as a permanent agent
 * (agentpier_team_promote), directly, through the owner's promotion path
 * (TeamStore.lifecycle). Unlike the owner's promotion, what the member ran with
 * becomes its own settings, independent of the lead from then on: its effective
 * capabilities, skills and MCP servers (its grants within what the lead holds at this
 * moment). Shell and SSH are never carried over; the owner sets them. It keeps only
 * its own memory, readable and writable: the copy of the lead's memory is removed,
 * as a specialist it builds its own knowledge. Name and instructions
 * stay. Visible: the member's history, a note in both chats, an audit record and a
 * notice in the lead's paired Telegram chat. The owner can archive it at any time.
 */
export class MemberPromotions {
  constructor({ teams, assistants, audit = null, onChanged = () => {} }) {
    // `onChanged` follows a promotion; TeamService.promote applies it itself.
    Object.assign(this, { teams, assistants, audit, onChanged });
  }
  async promote(inv, input) {
    exact(input, ["memberId"]);
    if (typeof input.memberId !== "string") throw assistantProblem("invalid");
    inv.assertCurrent();
    const a = this.assistants,
      attempt = a.ledger.getAttempt(inv.attemptId),
      request = a.ledger.getRequest(attempt.requestId),
      conversation = a.store.getConversation(request.conversationId),
      lead = a.store.getAssistant(conversation.assistantId);
    if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
    let member;
    try {
      member = this.teams.member(input.memberId);
    } catch {
      throw assistantProblem("teamGrantMemberEnded", 409);
    }
    if (!reachableMember(member, lead.id))
      throw assistantProblem("teamGrantMemberEnded", 409);
    // Never in the middle of a turn: the member's profile changes underneath it.
    if (this.teams.turnInFlight(member)) throw assistantProblem("active", 409);
    const agent = a.store.getAssistant(member.assistantId);
    const effective = agent.inherited;
    const servers = this.effectiveServers(member, lead.id);
    // Only its own memory stays (owner's decision): the copy of the lead's goes.
    await mirrorLeadMemory(a.config?.workspaces, agent, false);
    const entry = { at: new Date().toISOString(), by: "lead", promoted: true };
    // The flip, the history entry and the agent's own settings in one transaction.
    const next = this.teams.promoteByLead(member.id, member.revision, {
      memberPatch: {
        // Its servers are its own now; the team's grant never adds to them again.
        mcpGranted: true,
        grantLog: [...(member.grantLog || []), entry].slice(-kept),
      },
      settings: {
        // Its own memory, readable and writable like any agent's.
        capabilities: { ...effective.capabilities, memory: true },
        skills: [...effective.skills],
        shell: "off",
      },
    });
    const store = this.teams.servers();
    if (store) store.setBindings("agent", agent.id, servers);
    // A pending shell or SSH card for it can no longer be approved.
    a.teams?.grants?.cancelPending(
      lead.id,
      (card) => card.payload.memberId === member.id,
      "MEMBER_PROMOTED",
    );
    this.record(lead, next);
    this.note(lead, next, conversation, inv);
    this.notify(lead, next);
    this.onChanged(next);
    a.changed?.();
    return {
      status: "promoted",
      memberId: next.id,
      assistantId: next.assistantId,
      lifetime: "permanent",
    };
  }
  // The member's servers within what the lead holds right now.
  effectiveServers(member, leadId) {
    const store = this.teams.servers();
    if (!store) return [];
    const lead = new Set(store.bindings("agent", leadId));
    return [
      ...new Set([...(member.mcpServerIds || []), ...(member.grantedMcpServerIds || [])]),
    ].filter((id) => lead.has(id));
  }
  record(lead, member) {
    try {
      this.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: member.assistantId,
        source: "system",
        outcome: "success",
        details: {
          kind: "member-promote",
          teamId: member.teamId,
          leadAssistantId: lead.id,
        },
      });
    } catch (error) {
      console.error("Member promotion audit failed:", error?.message);
    }
  }
  // One settled row per chat, the member's and the lead's (actionNotes).
  note(lead, member, conversation, inv) {
    const store = this.assistants.workflows?.store;
    if (!store) return;
    const at = Date.now();
    for (const [assistantId, conversationId] of [
      [member.assistantId, member.conversationId],
      [lead.id, conversation.id],
    ]) {
      if (!conversationId) continue;
      store.reserve({
        assistantId,
        conversationId,
        attemptId: inv.attemptId,
        origin: { kind: "member-grant" },
        key: `member-promote:${inv.attemptId}:${inv.toolCallId}:${assistantId}`,
        state: "completed",
        payload: {
          action: "member_promote",
          memberId: member.id,
          memberName: member.name,
          teamId: member.teamId,
        },
        chatNotes: { result: { at, state: "completed" } },
        settled: true,
      });
    }
  }
  // The owner hears of it in the lead's paired Telegram chat, as of a team result.
  notify(lead, member) {
    const w = this.assistants.workflows;
    const channels = w?.s?.assistantChannels;
    const target = w && pairedTelegram(w, lead.id);
    if (!channels || !target) return;
    try {
      const m = telegramMessages(channels.store.get(target.channelId));
      channels.outbox.enqueue({
        key: `team-member-promoted:${member.id}`,
        source: target,
        kind: "team-member-promoted",
        localized: true,
        text: m.memberGrants.promoted(lead.name, member.name),
        path: `/agents/${encodeURIComponent(member.assistantId)}/settings`,
      });
    } catch (error) {
      console.error("Member promotion notice failed:", error?.message);
    }
  }
}
