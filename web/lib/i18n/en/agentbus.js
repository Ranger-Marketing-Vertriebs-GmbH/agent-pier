export const projectAgentBusCopy = {
  tabsLabel: "AgentBus view",
  messagesSegment: (count) => `Messages · ${count}`,
  messagesLabel: "Messages",
  messageCountUnavailable: "The message count could not be loaded.",
  connectedCount: (count) => `${count} connected`,
  pendingCount: (count) => `${count} messages waiting`,
  versionLabel: (version) => `Version ${version}`,
  waitingForSignIn: "Waiting for CLI sign-in",
  reloadRequired: "Reload required",
  reloadRequiredDescription:
    "Reload this session to use the current AgentBus integration.",
  agentbusPending: " in the inbox",
  noProjectMessages: "No sessions with AgentBus yet. Start a new coding CLI session.",
  missingProjectDescription: "This AgentBus project was not found.",
};
export const messageLogCopy = {
  extensionSectionAriaLabel: "AgentBus messages",
  inboxReadOnlyDescription:
    "Messages stay in their inbox. Opening this view does not mark them as read.",
  retryMessages: "Reload messages",
  messagesLoading: "Loading messages …",
  sectionHeadingHeading: "Messages in ",
  sectionHeadingLabel: " entries",
  agentbusMessageAriaLabel: "to",
  extensionEmpty: "No AgentBus messages in this project yet.",
};
