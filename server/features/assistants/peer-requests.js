import { assistantProblem } from "./assistant-validation.js";
import { editableMember, memberEnded } from "./member-reach.js";
import { mainConversation } from "./routine-targets.js";
import { peerFollowUp, peerLeadFollowUp } from "./lead-request-text.js";
import { createPeerRequest, peerCaller, peerTarget } from "./peer-request-rules.js";

/**
 * A member's questions and tasks for a sibling of the same lead (peer-request-rules.js
 * stores them). The lead's scheduler (lead-requests.js) dispatches and observes them
 * like its own; only their framing and where the outcome goes differ: back to the
 * asking member's chat, or to the lead's main chat when the asker wants it so or can
 * no longer be reached.
 */
export class PeerRequests {
  constructor({ teams, service, requests = service.requests }) {
    Object.assign(this, { teams, service, requests });
  }
  get assistants() {
    return this.service.assistants;
  }
  /** The caller's siblings it may ask; no request history and nothing of the lead. */
  peers(inv, input = {}) {
    if (input && Object.keys(input).length) throw assistantProblem("invalid");
    inv.assertCurrent();
    const { member: sender, lead } = peerCaller(this.service, inv);
    const reach = (m, type) => {
      try {
        return peerTarget(this.service, lead, sender, m.id, type).assistant;
      } catch {
        return null;
      }
    };
    return {
      members: this.teams.members().flatMap((m) => {
        if (m.parentAssistantId !== lead.id) return [];
        const a = reach(m, "question");
        return a
          ? [
              {
                memberId: m.id,
                name: a.name,
                role: m.role,
                lifetime: m.lifetime,
                busy: this.teams.activeMember(m),
                canDelegate: !!reach(m, "task"),
                phase: m.phase,
              },
            ]
          : [];
      }),
    };
  }
  async peer_ask(inv, input) {
    const r = await this.create("question", inv, input);
    const answered = await this.requests.waitFor(r.id, inv, this.requests.waitMs);
    return this.requests.toolResult(answered);
  }
  async peer_delegate(inv, input) {
    return this.requests.toolResult(await this.create("task", inv, input));
  }
  create(type, inv, input) {
    inv.assertCurrent();
    return this.requests.started(createPeerRequest(this.service, { type, inv, input }));
  }
  /**
   * Whether the asking member can still take its answer: member, agent and chat not
   * archived, still a member its lead could edit, and not a temporary member whose
   * task ended (its servers are gone; the lead takes the result instead).
   */
  reachable(r) {
    try {
      const sender = this.teams.find(r.fromMemberId);
      if (!sender || !editableMember(sender, r.parentAssistantId)) return false;
      if (sender.lifetime !== "permanent" && memberEnded.has(sender.phase)) return false;
      const store = this.assistants.store;
      if (store.getAssistant(r.fromAssistantId).archivedAt) return false;
      const chat = store.getConversation(r.fromConversationId);
      return !chat.archivedAt && chat.assistantId === r.fromAssistantId;
    } catch {
      return false;
    }
  }
  /** Where a sibling's finished request goes (deliverRequest); null for the lead's. */
  target(r) {
    if (!r.fromMemberId) return null;
    const full = { ...r, answer: this.requests.store.answer(r) };
    if (r.resultTo !== "lead" && this.reachable(r))
      return {
        conversationId: r.fromConversationId,
        clientRequestId: `peer-request-result:${r.id}`,
        text: peerFollowUp(full),
        context: { kind: "peer-result", requestId: r.id },
        record: { deliveredTo: "member" },
      };
    // The lead acts on it like on any member result (member-result-writes.js).
    // The lead's main chat as it is now: one opened after the request still counts.
    return {
      conversationId:
        mainConversation(this.assistants.store, r.parentAssistantId)?.id ?? null,
      clientRequestId: `lead-request-result:${r.id}`,
      text: peerLeadFollowUp(full),
      context: { kind: "member-result", requestId: r.id },
      record: { deliveredTo: "lead" },
    };
  }
}
