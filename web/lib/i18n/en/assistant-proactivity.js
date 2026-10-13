export const assistantProactivityCopy = {
  title: "Acting on its own",
  intro:
    "Optional ways for the agent to act without being asked. Everything here is off until you switch it on.",
  heartbeat: "Check in on its own",
  heartbeatDescription:
    "At set times the agent reads its conversation and notes and decides whether something needs your attention. Only then does it write in its chat, which also reaches your paired Telegram chat.",
  heartbeatChannel: "Needs a paired Telegram chat for this agent.",
  heartbeatReply:
    "Check-ins appear in the agent's chat, marked “Check-in:” on Telegram, so you can reply to them directly. A check-in that comes due while the agent is answering appears after that answer and may not know it yet.",
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
      ? "About 1 extra model run per day, each reading the recent conversation."
      : `About ${runs} extra model runs per day, each reading the recent conversation.`,
};
