/**
 * Where reminders, routines and check-ins deliver (AGENTPIER-141). Their target is
 * always the agent's main chat: its one AgentPier conversation, the one
 * `openConversation` returns and a Telegram pairing also writes into. A push notice
 * goes with every result. Telegram is an optional extra destination per binding.
 */

/** The agent's main chat, or null before the agent has one. */
export function mainConversation(store, assistantId) {
  return (
    store
      .listConversations()
      .find(
        (c) =>
          c.assistantId === assistantId && c.channel === "agentpier" && !c.archivedAt,
      ) || null
  );
}

/** The agent's paired, enabled Telegram chat, or null. */
export function pairedChannel(channels, assistantId) {
  return (
    channels.store
      .list()
      .find((c) => c.assistantId === assistantId && c.enabled && c.chatId) || null
  );
}

/** A Telegram destination as a binding stores it. */
export const telegramTarget = (channel) => ({
  channelId: channel.id,
  chatId: channel.chatId,
  userId: channel.userId,
});

/**
 * The Telegram chat a binding also delivers to, or null. A binding stored before
 * chat delivery kept its chat in `source` and delivers there still.
 */
export function telegramOf(binding) {
  if (binding.telegram !== undefined) return binding.telegram;
  const { channelId, chatId, userId } = binding.source || {};
  return channelId ? { channelId, chatId, userId } : null;
}

/** The binding's Telegram chat when it is still paired and enabled, or null. */
export function deliverableChannel(channels, telegram) {
  if (!telegram) return null;
  const channel = channels.store.list().find((c) => c.id === telegram.channelId);
  return channel?.enabled && channel.chatId ? channel : null;
}
