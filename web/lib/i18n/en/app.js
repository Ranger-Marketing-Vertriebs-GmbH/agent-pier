export const appCopy = {
  appAriaLabel: "Close navigation",
  pageDescription: "This link is unavailable.",
  returnToOverview: "Back to overview",
  workspaceLoading: "Loading workspace …",
  agentBusLoading: "Loading AgentBus …",
};
export const appDialogsCopy = {
  keychainRetention: " CLI-managed keychain entries may be retained.",
  titleStop: "Stop session?",
  titleRemove: "Remove session?",
  titleDeleteAccount: "Delete account?",
  buttonLogin: "Open sign-in terminal",
  renamedSessionLabel: "New name",
  confirmCopyStop: (value1) =>
    `“${value1}” and its running process will be stopped. The existing terminal output will remain readable.`,
  confirmCopyRemove: (value1) =>
    `“${value1}” and its saved terminal output will be permanently removed.`,
  confirmCopyDeleteAccount: (value1, value2) =>
    `The profile “${value1}” and its local files will be deleted.${value2}`,
  confirmCopyLogin: (value1) =>
    `Native sign-in for “${value1}” will open in a separate session. Follow your tool’s instructions there.`,
};
export const mobileHeaderCopy = {
  iconButtonAriaLabel: "Open navigation",
  mobileBrand: "AgentPier",
};
export const sidebarCopy = {
  brandAriaLabel: "AgentPier home",
  brandLabel: "AgentPier",
  localBadge: "LOCAL",
  ariaLabel: "Main navigation",
  repositoriesNavigation: "Repositories",
  extensionsNavigation: "MCP & Skills",
  pluginsNavigation: "Plugins & Marketplace",
  agentBusNavigation: "AgentBus",
  sidebarEmptyDescription: "Room for your next idea.",
  sidebarEmptyLabel: "Your sessions will appear here.",
  hostStatusLabel: "Local workspace",
  serviceConnecting: "Connecting",
  localHostDescription: "On your computer",
  remoteLink: "Open remotely",
  sidebarCaption: "YOUR COMPUTER. YOUR TOOLS.",
};
export const sidebarGroupCopy = {
  activeTerminalLabel: "Terminal active",
  labelsUnknown: "Activity unknown",
};
export const useWorkspaceNavigationCopy = {
  pageNotFound: "Page not found",
  sessionNotFound: "Session not found",
  profileNotFound: "Profile not found",
};
export const useWorkspaceStateCopy = {
  serviceConnectionError: (value1) => `Connection to the local service failed: ${value1}`,
};
export const appRecoveryCopy = {
  title: "View unavailable",
  description: "The app could not load this view. Please reload it.",
  reload: "Reload view",
};
