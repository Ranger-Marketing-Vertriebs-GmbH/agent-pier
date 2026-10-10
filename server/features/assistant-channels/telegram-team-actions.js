import { telegramMessages } from "./telegram-messages.js";
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
    let text;
    try {
      if (entry.kind === "action-approval") {
        await c.assistants.workflows.decide(
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
      text =
        entry.kind === "action-approval"
          ? messages.actionStates[action.decision === "approve" ? "approved" : "declined"]
          : action.decision === "approve"
            ? messages.teamApproved
            : messages.teamDeclined;
      if (entry.diagnostic === "DECISION_FAILED")
        try {
          c.outbox.transition(entry.id, entry.state, { diagnostic: null });
        } catch {}
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) text = messages.teamDecisionStale;
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
