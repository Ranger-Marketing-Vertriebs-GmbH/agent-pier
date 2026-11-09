/** Copy of agent cards (agent-cards.js): CARD_* problems and the Telegram fallback. */
export const agentCards = Object.freeze({
  CARD_INVALID: (detail) =>
    `The card was rejected (${detail}). Fix that part and call agentpier_card again; the tool description lists the blocks and their limits.`,
  CARD_TOO_LARGE: (max) =>
    `The card is larger than ${max} bytes. Shorten its texts or split it into two cards.`,
  CARD_NOT_FOUND:
    "There is no such card in this chat. Call agentpier_card with action read and no cardId for the cards of this chat.",
  CARD_FROZEN:
    "This card is frozen: the chat holds newer cards, and only the newest 30 stay open. Create a new card instead.",
  CARD_CHANGED: "The card has changed in the meantime. Look at it again.",
  CARD_UNAVAILABLE:
    "Cards are not available in this run: only an agent's own chat turns, routines and hooks may create or change cards, and only in the chat they belong to. Do not retry; answer in text.",
  telegram: Object.freeze({
    open: "Open the chat in AgentPier to use this card.",
    more: (count) => `… ${count} more`,
    chart: (count) => `Chart (${count} values)`,
  }),
});
