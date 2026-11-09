// Agent cards in the agent chat: interactive cards an agent puts into the chat
// (web/features/assistants/cards/).
export const agentCardsCopy = {
  label: (title) => `Card: ${title}`,
  version: (n) => `Version ${n}`,
  updated: "updated",
  frozen: "This card is closed: newer cards of this chat replaced it.",
  moved: (title) => `“${title}” was updated – shown further down`,
  showMoved: (title) => `Show the updated card “${title}”`,
  chart: (title) => (title ? `Chart: ${title}` : "Chart"),
  states: { ok: "OK", warn: "Warning", fail: "Problem", unknown: "Unknown" },
  readOnly: "Only the person this chat belongs to can use this card.",
  waiting: "The buttons work again once the agent has answered.",
};
