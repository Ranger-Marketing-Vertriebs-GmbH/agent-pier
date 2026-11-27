// What an agent used (docs/agents.md "Usage"): the group on its Overview
// tab and the usage of one chat in the chat's header.
export const assistantUsageCopy = {
  title: "Usage",
  hint: "The tokens this agent used in all: in its chats, routines and check-ins and through its bot. A cost shows where the model has a price: OpenRouter models, and endpoints that report one. A ChatGPT account is a subscription without a price per token, so it shows tokens only.",
  periods: { today: "Today", week: "Last 7 days", month: "Last 30 days" },
  tokens: (count) => `${count} tokens`,
  breakdown: (input, output) => `${input} in · ${output} out`,
  cached: (count) => `${count} from cache`,
  none: "No usage",
  noPrice: "No price",
  atLeast: (amount) => `at least ${amount}`,
  pending: "Still being calculated …",
  unavailable: "The usage cannot be read right now.",
  chart: "Tokens per day over the last 30 days",
  chat: {
    title: "Usage of this chat",
    button: (tokens) => `Usage of this chat: ${tokens} tokens`,
    cacheRead: "Read from cache",
    cacheWrite: "Written to cache",
    costPartial: "Some model calls have no price, so the cost is at least this amount.",
    noPriceHint:
      "This chat's model has no price per token (a ChatGPT account, or an endpoint that reports none), so no cost is shown.",
    context: "Context at the last model call",
    contextOf: (used, limit, percent) => `${used} of ${limit} tokens (${percent} %)`,
    contextUsed: (used) => `${used} tokens`,
  },
  search: { tokens: "Tokens", cost: "Cost", chatTokens: "Tokens of this chat" },
};
