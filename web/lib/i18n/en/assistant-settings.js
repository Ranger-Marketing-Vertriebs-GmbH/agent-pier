export const assistantSettingsCopy = {
  tabsLabel: "Agent settings",
  tabs: {
    profile: "Profile",
    capabilities: "Capabilities",
    work: "Work",
    routines: "Routines & check-ins",
    telegram: "Telegram",
  },
  createAgent: "Create agent",
  backTo: (tab) => `Back to ${tab}`,
  searchProvider: (name) => `Search provider · ${name}`,
  speechProvider: "Speech recognition · Deepgram",
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  manageMcpServers: "Manage MCP servers",
  pendingApprovals: (count) => `Waiting for your approval · ${count}`,
  numberRange: (min, max) => `Enter a whole number from ${min} to ${max}.`,
  teamGroup: "Team",
  connectionGroup: "Connection",
  connectionPage: "Connection",
  activityAttention: (count) =>
    count === 1 ? "1 needs your decision" : `${count} need your decision`,
  allDelivered: "All delivered",
  noActivity: "No activity yet",
  replaceToken: "Replace bot token",
  replaceTokenHint: "Only a new token for the same bot is accepted.",
  addReminder: "+ Create reminder",
  addRoutine: "+ Routine",
  remindersNeedCapability:
    "Reminders and routines are off for this agent. Switch on “Allow reminders and routines” under Capabilities.",
  heartbeatNeedsMemory:
    "Needs memory: switch on “Remember information” under Capabilities.",
};
