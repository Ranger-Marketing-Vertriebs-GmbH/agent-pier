export const assistantProactivityCopy = {
  title: "Acting on its own",
  intro:
    "Optional ways for the agent to act without being asked. Everything here is off until you switch it on.",
  recall: "Remember across conversations",
  recallDescription:
    "Before replying, searches this agent's own earlier conversations, for example between AgentPier and Telegram. Never another agent's.",
  recallNeedsMemory: "Needs memory to be switched on above.",
  recallCost:
    "A message that refers to earlier conversations can cost one or two extra model calls.",
  heartbeat: "Check in on its own",
  heartbeatDescription:
    "At set times the agent checks whether something needs your attention. It messages your paired Telegram chat only when it has something to say.",
  heartbeatChannel: "Needs a paired Telegram chat for this agent.",
  heartbeatReply:
    "Messages start with “Check-in:”. The agent's chat does not contain them, so say what you are replying to.",
  interval: "How often",
  intervals: {
    "1h": "Every hour",
    "2h": "Every 2 hours",
    "4h": "Every 4 hours",
    daily: "Once a day",
  },
  activeFrom: "Active from",
  activeUntil: "Active until",
  hour: (hour) => `${String(hour).padStart(2, "0")}:00`,
  timeZone: (zone) => `Times in ${zone}, within one day.`,
  adoptZone: (zone) => `Use my time zone (${zone})`,
  heartbeatCost: (runs) =>
    runs === 1
      ? "About 1 extra model run per day."
      : `About ${runs} extra model runs per day.`,
};
