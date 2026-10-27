import { telegramMessages } from "./telegram-messages.js";
import { sessionMessages } from "../assistants/coding-sessions/session-escalation-notes.js";
export class TelegramTeamActions {
  constructor(channels) {
    this.channels = channels;
  }
  // Every callback is answered so the Telegram client stops its spinner, even
  // when handling fails before a decision is attempted; the error is rethrown
  // so ingress can record it while still acknowledging the update.
  async receive(channelId, update) {
    const c = this.channels,
      query = update.callback_query;
    let answered = false;
    const answer = async (text) => {
      answered = true;
      if (typeof query?.id !== "string") return;
      // Acknowledgement is cosmetic; the durable decision remains authoritative.
      try {
        await c.clientFactory(c.store.secret(channelId)).call("answerCallbackQuery", {
          callback_query_id: query.id,
          ...(text ? { text } : {}),
        });
      } catch {}
    };
    try {
      await this.decide(channelId, query, answer);
    } catch (error) {
      if (!answered)
        await answer(telegramMessages(c.store.get(channelId)).teamDecisionFailed);
      throw error;
    }
  }
  async decide(channelId, query, answer) {
    const c = this.channels,
      channel = c.store.get(channelId),
      messages = telegramMessages(channel);
    if (
      !c.assistants.teams ||
      !channel.enabled ||
      !query ||
      query.from?.is_bot !== false ||
      String(query.from.id) !== channel.userId ||
      query.message?.chat?.type !== "private" ||
      String(query.message.chat.id) !== channel.chatId ||
      typeof query.data !== "string"
    )
      return answer();
    const entry = c.outbox
      .all(channelId)
      .find((e) => e.actions?.some((a) => a.handle === query.data));
    const action = entry?.actions.find((a) => a.handle === query.data);
    if (
      !action ||
      action.expiresAt < Date.now() ||
      entry.source.chatId !== channel.chatId ||
      entry.source.userId !== channel.userId
    )
      return answer(messages.teamDecisionStale);
    let text, decided;
    try {
      if (entry.source.escalation && action.decision === "answer") {
        await c.assistants.workflows.sessions.answerEscalation(
          action.proposalId,
          action.answer,
          { channelId, chatId: channel.chatId, userId: channel.userId },
        );
        // An escalated session prompt (session-escalations.js) is answered, not decided.
        decided = {
          escalationText: sessionMessages(channel).escalationAnsweredBy.telegram,
        };
      } else if (entry.kind === "action-approval") {
        decided = await c.assistants.workflows.decide(
          action.proposalId,
          { revision: action.revision, decision: action.decision },
          { kind: "telegram", channelId, chatId: channel.chatId, userId: channel.userId },
        );
      } else
        c.assistants.teams.decide(
          action.proposalId,
          { revision: action.revision, decision: action.decision, lifetime: "task" },
          { kind: "telegram", channelId, chatId: channel.chatId, userId: channel.userId },
        );
      text = decisionText(messages, entry, action, decided);
      if (entry.diagnostic === "DECISION_FAILED")
        try {
          c.outbox.transition(entry.id, entry.state, { diagnostic: null });
        } catch {}
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status))
        text = entry.source.escalation
          ? sessionMessages(channel).escalationStale
          : messages.teamDecisionStale;
      else {
        // Record the failure on the notification instead of refetching the
        // update forever; the owner can still decide in AgentPier.
        text = messages.teamDecisionFailed;
        try {
          c.outbox.transition(entry.id, entry.state, { diagnostic: "DECISION_FAILED" });
        } catch {}
        c.assistants.changed();
      }
    }
    await answer(text);
  }
}
// The callback answer for a decision that was saved.
function decisionText(messages, entry, action, decided) {
  if (decided?.escalationText) return decided.escalationText;
  if (decided?.payload?.action === "exec") {
    const allowlist = decided.result?.allowlist;
    return messages.execDecided[
      allowlist && !allowlist.written ? "allow-once" : action.decision
    ];
  }
  if (entry.kind === "action-approval")
    return messages.actionStates[action.decision === "approve" ? "approved" : "declined"];
  return action.decision === "approve" ? messages.teamApproved : messages.teamDeclined;
}
