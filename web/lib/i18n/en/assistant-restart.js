export const assistantRestartCopy = {
  title: "Agent service restart pending",
  description:
    "Saved changes take effect once the agent service restarts. It restarts by itself as soon as no agent is busy.",
  running: "Restarting the agent service …",
  failed: "The last restart attempt failed. It is tried again shortly.",
  reasons: (labels) => `Needed for: ${labels}.`,
  reason: {
    webTools: "agent web tools",
    webSearch: "web search",
    pdfModel: "PDF reading",
    connection: "a provider connection",
    telegram: "a Telegram bot",
  },
  waiting: (labels) => `Waiting for: ${labels}.`,
  waitingFor: {
    ASSISTANT_WORK: "agents at work",
    TEAM_WORK: "team work",
    CHANNEL_WORK: "Telegram messages",
    ACCOUNT_LOGIN: "an account sign-in",
    WORKFLOW_WORK: "running workflows",
    SCHEDULED_WORK: "scheduled runs",
    active: "other maintenance",
    unavailable: "the agent service",
  },
  restartNow: "Restart now",
  restartNowDescription: "Restarts at once and interrupts all running agent work.",
  affected: (names, members = 0) =>
    `Interrupted: ${names || "no agents"}${members ? ` (+${members} team ${members === 1 ? "member" : "members"})` : ""}`,
  confirmTitle: "Restart the agent service now?",
  confirmBody:
    "All running agent work is interrupted, and agents are unavailable until the service is back. This can take about a minute or longer. An account sign-in or a running workflow still finishes first.",
};
