import { assistantProblem } from "./assistant-validation.js";
import { MAX_CAPTION_LENGTH, readShareSource, shareRoots } from "./agent-share-source.js";

/**
 * agentpier_share_file: an agent hands the owner a file from its own workspace.
 *
 * The copy joins the chat of the turn that shared it (agent-attachments.js share):
 * the owner's own chat, or a member's chat for a lead's question or task or a team
 * assignment. A member's file also appears in its lead's chat, attributed to the
 * member, since that is where the owner follows the lead's work. When the turn came
 * from the owner's Telegram chat (directly, or through the lead's turn a member works
 * for), the file is queued for that chat as well (telegram-file.js); Telegram never
 * sees a file from any other turn.
 *
 * A routine's run (no attempt; the bridge admits its run session as for SSH) shares
 * into the chat its routine commits to, and to the Telegram chat it delivers to.
 */
export class AgentShares {
  constructor({ assistants, channels = null }) {
    Object.assign(this, { assistants, channels });
  }
  async invoke(invocation, input) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some((key) => !["path", "caption"].includes(key)) ||
      typeof input.path !== "string" ||
      ("caption" in input &&
        (typeof input.caption !== "string" || input.caption.length > MAX_CAPTION_LENGTH))
    )
      throw assistantProblem("invalid");
    const a = this.assistants;
    // No workspace reads while a restore or update may replace them.
    if (a.closed || a.maintenance || a.recovering)
      throw assistantProblem("unavailable", 503);
    const { conversation, requestId, origin } = this.turn(invocation);
    const agent = a.store.getAssistant(conversation.assistantId);
    if (agent.archivedAt) throw assistantProblem("invalid", 403);
    const source = await readShareSource(
      shareRoots(a.attachments.config?.workspaces, agent),
      input.path,
    );
    invocation.assertCurrent();
    const caption = (input.caption || "").trim();
    const file = await a.attachments.share({
      conversation,
      requestId,
      ...source,
      caption,
      mirror: this.leadChat(origin, agent),
    });
    const telegram = this.telegram(origin, file, caption);
    this.audit(agent, origin, telegram);
    a.changed?.();
    return {
      status: "shared",
      file: { name: file.name, type: file.type, size: file.size },
      ...(telegram ? { telegram } : {}),
      note: "The owner sees the file in the chat now; do not repeat its contents unless asked.",
    };
  }
  // The chat, request key and trusted origin of the calling turn.
  turn(invocation) {
    const a = this.assistants;
    if (invocation.routine && !invocation.attemptId) {
      const { binding, conversation } = invocation.routine;
      // The run session names the run (agent:<id>:cron:<job>:run:<run id>).
      const run = /:run:([^:]+)$/i.exec(invocation.sessionKey || "")?.[1];
      return {
        conversation: a.store.getConversation(conversation.id),
        requestId: `routine:${run || binding.id}`,
        origin: binding.source
          ? { kind: "telegram", ...binding.source }
          : { kind: "routine" },
      };
    }
    if (!invocation.attemptId) throw assistantProblem("invalid", 403);
    const attempt = a.ledger.getAttempt(invocation.attemptId);
    const request = a.ledger.getRequest(attempt.requestId);
    return {
      conversation: a.store.getConversation(request.conversationId),
      requestId: request.id,
      origin: a.teams?.store?.context(request.id) || { kind: "unknown" },
    };
  }
  // The lead's chat a member's turn works for, or null.
  leadChat(origin, agent) {
    const teams = this.assistants.teams;
    if (!agent.teamMemberId || !teams) return null;
    let conversationId = null;
    try {
      if (origin.kind === "lead-request")
        conversationId = teams.requests?.store.get(origin.requestId).parentConversationId;
      else if (origin.kind === "team-member")
        conversationId = teams.store.find(origin.teamId)?.parentConversationId;
      if (typeof conversationId !== "string") return null;
      this.assistants.store.getConversation(conversationId);
    } catch {
      return null;
    }
    return { conversationId, from: agent.name };
  }
  // The owner's paired Telegram chat the turn came from, while it is still paired.
  target(origin) {
    const own =
      origin.kind === "telegram"
        ? origin
        : origin.telegram && typeof origin.telegram === "object"
          ? origin.telegram
          : null;
    if (!own || !this.channels) return null;
    try {
      const channel = this.channels.store.get(own.channelId);
      if (
        !channel.enabled ||
        channel.chatId !== own.chatId ||
        channel.userId !== own.userId
      )
        return null;
      return { channelId: channel.id, chatId: channel.chatId, userId: channel.userId };
    } catch {
      return null;
    }
  }
  // Queues the file for Telegram; the chat copy stands even when this fails.
  telegram(origin, file, caption) {
    const target = this.target(origin);
    if (!target) return null;
    try {
      this.channels.outbox.enqueue({
        key: `share:${file.id}`,
        source: { ...target, attachmentId: file.id },
        kind: "file",
        // Shown in the channel's activity list; Telegram gets only the caption.
        text: caption || file.name,
        caption,
      });
      return "queued";
    } catch {
      return "unavailable";
    }
  }
  audit(agent, origin, telegram) {
    try {
      this.assistants.audit?.append({
        action: "assistant.sent",
        resourceType: "assistant",
        resourceId: agent.id,
        source: "system",
        outcome: "success",
        details: {
          kind: "share",
          channel: telegram === "queued" ? "telegram" : "tool",
          ...(origin.kind === "lead-request" && origin.leadAssistantId
            ? { leadAssistantId: origin.leadAssistantId }
            : {}),
        },
      });
    } catch {
      /* The share stands; the audit log reports its own failures. */
    }
  }
}
