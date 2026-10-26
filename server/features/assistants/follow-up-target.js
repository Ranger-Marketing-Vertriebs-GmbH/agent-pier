import { pairedChannel, telegramTarget } from "./routine-targets.js";

/**
 * The Telegram chat a run AgentPier did not start in `conversation` belongs to
 * (OpenClaw's own follow-up after a background command, for example), as
 * `{ channelId, chatId, userId }`, or null. Such a run continues the conversation's
 * latest turn: it belongs to the owner's paired Telegram chat when that turn came
 * from there, and only while that chat is still the agent's paired, enabled chat
 * writing into this conversation with the same ids, so a re-paired chat or another
 * person's chat never receives anything. Its exec approvals ask there
 * (exec-approvals.js) and its reply goes there (telegram-follow-ups.js).
 */
export function followUpTelegram(assistants, channels, assistant, conversation) {
  const latest = assistants.ledger?.latestRequest(conversation.id);
  const context = latest && assistants.teams?.store.context(latest.id);
  if (context?.kind !== "telegram" || !channels?.store?.list) return null;
  const channel = pairedChannel(channels, assistant.id);
  if (!channel || channel.conversationId !== conversation.id) return null;
  const target = telegramTarget(channel);
  return ["channelId", "chatId", "userId"].every(
    (k) => String(target[k] ?? "") === String(context[k] ?? ""),
  )
    ? target
    : null;
}
